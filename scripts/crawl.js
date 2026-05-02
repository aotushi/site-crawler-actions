// scripts/crawl.js
// Playwright-based site crawler for GitHub Actions
// Input:  TARGET_URL env var
// Output: output/site.zip

'use strict'

const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const { URL } = require('url')
const JSZip = require('jszip')

const TARGET_URL = process.env.TARGET_URL
if (!TARGET_URL) {
  console.error('ERROR: TARGET_URL environment variable is required')
  process.exit(1)
}

const MAX_PAGES = 50
const MAX_ASSETS = 300
const OUTPUT_DIR = path.join(process.cwd(), 'output')
const OUTPUT_ZIP = path.join(OUTPUT_DIR, 'site.zip')

const STATIC_EXTS = new Set([
  '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.webm', '.pdf', '.xml', '.txt',
])

function urlToZipPath(urlStr) {
  try {
    const parsed = new URL(urlStr)
    let p = parsed.pathname.replace(/^\//, '') || 'index.html'
    if (p.endsWith('/')) {
      p += 'index.html'
    } else {
      const ext = path.extname(p).toLowerCase()
      if (!ext || (!STATIC_EXTS.has(ext) && ext !== '.html' && ext !== '.htm')) {
        p = p + '/index.html'
      }
    }
    return p
  } catch {
    return 'index.html'
  }
}

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 SiteCrawlerBot/1.0' },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href
        return fetchBinary(redirectUrl).then(resolve).catch(reject)
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
  })
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  fs.mkdirSync(path.join(process.cwd(), 'scripts'), { recursive: true })

  const origin = new URL(TARGET_URL).origin
  const visitedPages = new Set()
  const assetUrls = new Set()
  const pageQueue = [TARGET_URL]
  const zip = new JSZip()

  console.log(`Starting crawl: ${TARGET_URL}`)
  console.log(`Origin: ${origin}`)

  const browser = await chromium.launch()
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  })

  // Phase 1: crawl pages with Playwright
  while (pageQueue.length > 0 && visitedPages.size < MAX_PAGES) {
    const url = pageQueue.shift()
    const cleanUrl = url.split('#')[0]
    if (visitedPages.has(cleanUrl)) continue
    visitedPages.add(cleanUrl)

    const page = await context.newPage()
    try {
      // Intercept requests to collect asset URLs
      page.on('request', req => {
        const reqUrl = req.url().split('?')[0].split('#')[0]
        if (!reqUrl.startsWith(origin)) return
        const ext = path.extname(new URL(reqUrl).pathname).toLowerCase()
        if (STATIC_EXTS.has(ext)) {
          assetUrls.add(reqUrl)
        }
      })

      await page.goto(cleanUrl, { waitUntil: 'networkidle', timeout: 30000 })

      // Collect same-origin links
      const links = await page.evaluate((origin) => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => {
            try { return new URL(a.href).href } catch { return null }
          })
          .filter(h => h && h.startsWith(origin))
      }, origin)

      for (const link of links) {
        const clean = link.split('#')[0]
        if (!visitedPages.has(clean) && !pageQueue.includes(clean)) {
          pageQueue.push(clean)
        }
      }

      // Also collect img/link/script src attributes
      const resourceUrls = await page.evaluate((origin) => {
        const urls = []
        document.querySelectorAll('img[src], img[data-src], source[src], source[srcset]').forEach(el => {
          const src = el.getAttribute('src') || el.getAttribute('data-src') || ''
          const srcset = el.getAttribute('srcset') || ''
          if (src) try { const u = new URL(src, location.href); if (u.origin === origin) urls.push(u.href) } catch {}
          srcset.split(',').forEach(s => {
            const part = s.trim().split(/\s+/)[0]
            if (part) try { const u = new URL(part, location.href); if (u.origin === origin) urls.push(u.href) } catch {}
          })
        })
        document.querySelectorAll('link[rel="stylesheet"][href]').forEach(el => {
          try { const u = new URL(el.href); if (u.origin === origin) urls.push(u.href) } catch {}
        })
        document.querySelectorAll('script[src]').forEach(el => {
          try { const u = new URL(el.src); if (u.origin === origin) urls.push(u.href) } catch {}
        })
        return urls
      }, origin)

      for (const u of resourceUrls) {
        assetUrls.add(u.split('?')[0].split('#')[0])
      }

      // Save rendered HTML
      const html = await page.content()
      const zipPath = urlToZipPath(cleanUrl)
      zip.file(zipPath, html)
      console.log(`[page] ${cleanUrl} → ${zipPath}`)
      const estimatedTotal = Math.min(pageQueue.length + visitedPages.size, MAX_PAGES)
      console.log(`[PROGRESS] phase=crawl downloaded=${visitedPages.size} total=${estimatedTotal}`)
    } catch (e) {
      console.warn(`[warn] Failed to crawl ${cleanUrl}: ${e.message}`)
    } finally {
      await page.close()
    }
  }

  await browser.close()
  console.log(`Pages crawled: ${visitedPages.size}, Assets to download: ${assetUrls.size}`)

  // Phase 2: download static assets
  let assetCount = 0
  for (const assetUrl of assetUrls) {
    if (assetCount >= MAX_ASSETS) break
    try {
      const data = await fetchBinary(assetUrl)
      const zipPath = urlToZipPath(assetUrl)
      zip.file(zipPath, data)
      assetCount++
      if (assetCount % 10 === 0) {
        console.log(`[PROGRESS] phase=assets downloaded=${assetCount} total=${Math.min(assetUrls.size, MAX_ASSETS)}`)
      }
    } catch (e) {
      console.warn(`[warn] Asset failed ${assetUrl}: ${e.message}`)
    }
  }
  console.log(`Assets downloaded: ${assetCount}`)

  // Phase 3: write ZIP
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } })
  fs.writeFileSync(OUTPUT_ZIP, zipBuffer)
  console.log(`Done. ZIP: ${OUTPUT_ZIP} (${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB)`)
}

main().catch(e => {
  console.error('Crawl failed:', e)
  process.exit(1)
})
