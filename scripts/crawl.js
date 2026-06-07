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

const MAX_ASSETS = parseInt(process.env.MAX_ASSETS || '0', 10) // 0 = unlimited
const OUTPUT_DIR = path.join(process.cwd(), 'output')
const OUTPUT_ZIP = path.join(OUTPUT_DIR, 'site.zip')

const STATIC_EXTS = new Set([
  '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.webm', '.pdf', '.xml', '.txt',
])

function urlToZipPath(urlStr, origin) {
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
    // 跨域资源放到 _external/<host>/ 下，避免与同源路径碰撞
    if (origin && parsed.origin !== origin) {
      p = `_external/${parsed.hostname}/${p}`
    }
    return p
  } catch {
    return 'index.html'
  }
}

// 按 content-type 兜底判断是否为可保存的静态资源（覆盖无扩展名/动态 URL）
function isAssetContentType(ct) {
  if (!ct) return false
  ct = ct.toLowerCase()
  return ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/') ||
    ct.startsWith('font/') || ct.includes('css') || ct.includes('javascript') ||
    ct.includes('/json') || ct.includes('font') || ct.includes('octet-stream')
}

// 反爬质询页特征（Imperva/Incapsula "One moment, please..." 等）
function isChallengeTitle(title) {
  return /one moment|just a moment|attention required|please wait|checking your browser|access denied/i.test(title || '')
}

// 检测到质询页则等待并多次 reload，让浏览器执行 JS 并带上质询 cookie 直至放行
async function passChallenge(page) {
  for (let i = 0; i < 5; i++) {
    const title = await page.title().catch(() => '')
    if (!isChallengeTitle(title)) return true
    console.log(`[challenge] "${title}" → 等待重试 ${i + 1}/5`)
    await page.waitForTimeout(6000)
    try { await page.reload({ waitUntil: 'networkidle', timeout: 30000 }) } catch {}
  }
  const finalTitle = await page.title().catch(() => '')
  return !isChallengeTitle(finalTitle)
}

// 逐屏滚动到底，触发懒加载（Elementor 幻灯片、lazyload 图片等），再回到顶部
async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      const delay = (ms) => new Promise(r => setTimeout(r, ms))
      let last = -1
      for (let i = 0; i < 100; i++) {
        window.scrollTo(0, document.body.scrollHeight)
        await delay(350)
        const h = document.body.scrollHeight
        if (h === last) break
        last = h
      }
      window.scrollTo(0, 0)
    })
    await page.waitForLoadState('networkidle', { timeout: 15000 })
  } catch {
    // 滚动/等待失败不影响主流程
  }
}

// 将 HTML 中的绝对路径重写为相对路径，使本地打开时链接可用
function rewriteAbsolutePaths(html, zipPath) {
  const depth = zipPath.split('/').length - 1
  const prefix = depth > 0 ? '../'.repeat(depth) : './'

  return html
    // href="/..." src="/..." action="/..."，跳过 // 协议相对 URL 和 # 锚点
    .replace(/(href|src|action)="(\/(?!\/)([^"#]*))/g, (_, attr, _full, rest) => {
      return `${attr}="${prefix}${rest}"`
    })
    // srcset 里的绝对路径
    .replace(/srcset="([^"]*)"/g, (_, srcset) => {
      const rewritten = srcset.replace(/(^|,\s*)(\/(?!\/)([^\s,]*))/g, (m, sep, _full, rest) => {
        return `${sep}${prefix}${rest}`
      })
      return `srcset="${rewritten}"`
    })
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
  const assetMap = new Map() // url(去 query) -> { buffer, zipPath }，response 直存（含跨域/懒加载）
  const pageQueue = [TARGET_URL]
  const zip = new JSZip()

  console.log(`Starting crawl: ${TARGET_URL}`)
  console.log(`Origin: ${origin}`)

  const browser = await chromium.launch()
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  })

  // Phase 1: crawl pages with Playwright
  while (pageQueue.length > 0) {
    const url = pageQueue.shift()
    const cleanUrl = url.split('#')[0]
    if (visitedPages.has(cleanUrl)) continue
    visitedPages.add(cleanUrl)

    const page = await context.newPage()
    const pending = [] // response.body() 的异步取回，page.close 前需 settle
    try {
      // Intercept requests to collect asset URLs（同源兜底用）
      page.on('request', req => {
        const reqUrl = req.url().split('?')[0].split('#')[0]
        if (!reqUrl.startsWith(origin)) return
        const ext = path.extname(new URL(reqUrl).pathname).toLowerCase()
        if (STATIC_EXTS.has(ext)) {
          assetUrls.add(reqUrl)
        }
      })

      // 直接保存浏览器实际拿到的响应体（含 JS 注入/懒加载/跨域资源）
      page.on('response', resp => {
        pending.push((async () => {
          try {
            const req = resp.request()
            if (req.method() !== 'GET') return
            if (req.resourceType() === 'document') return // 页面 HTML 由 page.content() 处理
            const status = resp.status()
            if (status < 200 || status >= 300) return
            const noQuery = resp.url().split('#')[0].split('?')[0]
            if (assetMap.has(noQuery)) return
            const ct = resp.headers()['content-type'] || ''
            const ext = path.extname(new URL(noQuery).pathname).toLowerCase()
            if (!STATIC_EXTS.has(ext) && !isAssetContentType(ct)) return
            const buffer = await resp.body()
            if (buffer && buffer.length) {
              assetMap.set(noQuery, { buffer, zipPath: urlToZipPath(noQuery, origin) })
            }
          } catch {
            // 单个响应取回失败忽略
          }
        })())
      })

      await page.goto(cleanUrl, { waitUntil: 'networkidle', timeout: 30000 })
      // 反爬质询页（"One moment, please..." 等）：等待并多次 reload 直至放行
      const passed = await passChallenge(page)
      if (!passed) {
        console.warn(`[warn] 质询未通过，跳过 ${cleanUrl}`)
        continue
      }
      // Nuxt/Vue SSR 首次加载时 hydration 可能未完成，reload 一次确保内容渲染
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 })
      // 滚动触发懒加载资源（Elementor 背景幻灯片等）
      await autoScroll(page)

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

      // Save rendered HTML（绝对路径重写为相对路径，本地打开可用）
      const zipPath = urlToZipPath(cleanUrl, origin)
      const html = rewriteAbsolutePaths(await page.content(), zipPath)
      zip.file(zipPath, html)
      console.log(`[page] ${cleanUrl} → ${zipPath}`)
      const estimatedTotal = pageQueue.length + visitedPages.size
      console.log(`[PROGRESS] phase=crawl downloaded=${visitedPages.size} total=${estimatedTotal}`)
      // 等待本页所有 response.body() 取回，再关闭页面
      await Promise.allSettled(pending)
    } catch (e) {
      console.warn(`[warn] Failed to crawl ${cleanUrl}: ${e.message}`)
    } finally {
      await page.close()
    }
  }

  await browser.close()
  console.log(`Pages crawled: ${visitedPages.size}, Captured(response): ${assetMap.size}, DOM/request urls: ${assetUrls.size}`)

  // Phase 2a: 写入浏览器已直接拿到的响应体（含跨域/懒加载，无需重新下载）
  let assetCount = 0
  const totalEstimate = assetMap.size + assetUrls.size
  for (const [, { buffer, zipPath }] of assetMap) {
    zip.file(zipPath, buffer)
    assetCount++
  }
  console.log(`[PROGRESS] phase=assets downloaded=${assetCount} total=${totalEstimate}`)

  // Phase 2b: 兜底下载 DOM/request 收集到但响应未捕获的同源资源
  for (const assetUrl of assetUrls) {
    if (MAX_ASSETS > 0 && assetCount >= MAX_ASSETS) break
    const noQuery = assetUrl.split('?')[0]
    if (assetMap.has(noQuery)) continue
    try {
      const data = await fetchBinary(assetUrl)
      const zipPath = urlToZipPath(assetUrl, origin)
      zip.file(zipPath, data)
      assetCount++
      if (assetCount % 10 === 0) {
        console.log(`[PROGRESS] phase=assets downloaded=${assetCount} total=${totalEstimate}`)
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
