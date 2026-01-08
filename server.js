const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { URL } = require("url");
const archiver = require("archiver");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// Helper to extract clean domain name from URL
function getDomainName(url) {
  try {
    const parsed = new URL(url);
    // Remove www. and replace dots with dashes
    return parsed.hostname.replace(/^www\./, "").replace(/\./g, "-");
  } catch {
    return "unknown";
  }
}

// Generate session ID with domain name for better folder naming
function generateSessionId(url) {
  const domain = getDomainName(url);
  const shortId = uuidv4().split("-")[0]; // Just use first part of UUID
  const timestamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${domain}_${timestamp}_${shortId}`;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/screenshots", express.static(path.join(__dirname, "screenshots")));
app.use("/videos", express.static(path.join(__dirname, "videos")));

// Ensure screenshots directory exists
const screenshotsDir = path.join(__dirname, "screenshots");
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// Store active crawl sessions
const activeSessions = new Map();

// Utility to normalize URLs
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Remove trailing slash, hash, and normalize
    let normalized =
      parsed.origin + parsed.pathname.replace(/\/$/, "") + parsed.search;
    return normalized;
  } catch {
    return url;
  }
}

// Smart URL pattern detection
// Converts URLs like /category/my-slug-123 to /category/{item}
// This helps identify URLs that represent the same content type
function getUrlPattern(url) {
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split("/").filter(Boolean);

    // Common collection/listing path segments that indicate the next segment(s) are items
    const collectionPaths = new Set([
      // E-commerce
      "product",
      "products",
      "item",
      "items",
      "category",
      "categories",
      "cat",
      "collection",
      "collections",
      "shop",
      "store",
      "catalog",
      "brand",
      "brands",
      "tag",
      "tags",
      // Content
      "blog",
      "blogs",
      "post",
      "posts",
      "article",
      "articles",
      "news",
      "page",
      "pages",
      "portfolio",
      "project",
      "projects",
      "gallery",
      "galleries",
      "event",
      "events",
      "case-study",
      "case-studies",
      // Users/Authors
      "author",
      "authors",
      "user",
      "users",
      "profile",
      "profiles",
      "team",
      "member",
      "members",
      // Documentation
      "docs",
      "doc",
      "documentation",
      "guide",
      "guides",
      "tutorial",
      "tutorials",
      "lesson",
      "lessons",
      // Forums/Community
      "topic",
      "topics",
      "thread",
      "threads",
      "forum",
      "forums",
      "discussion",
      "discussions",
      // Media
      "video",
      "videos",
      "photo",
      "photos",
      "image",
      "images",
      // Real Estate / Listings
      "property",
      "properties",
      "listing",
      "listings",
      "apartment",
      "apartments",
      "house",
      "houses",
      // Jobs
      "job",
      "jobs",
      "career",
      "careers",
      "vacancy",
      "vacancies",
      // Services
      "service",
      "services",
      // Localization
      "location",
      "locations",
      "city",
      "cities",
      "region",
      "regions",
    ]);

    // Track if previous segment was a collection path
    let afterCollectionPath = false;

    const patternSegments = pathSegments.map((segment, index) => {
      const lowerSegment = segment.toLowerCase();

      // Check if this segment is a collection path indicator
      if (collectionPaths.has(lowerSegment)) {
        afterCollectionPath = true;
        return segment; // Keep the collection path as-is
      }

      // If we're after a collection path, treat this segment as an item
      if (afterCollectionPath) {
        afterCollectionPath = false; // Reset for nested paths
        return "{item}";
      }

      // Check if segment is a UUID
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          segment
        )
      ) {
        return "{uuid}";
      }

      // Check if segment is purely numeric (ID)
      if (/^\d+$/.test(segment)) {
        return "{id}";
      }

      // Check if segment looks like a slug (contains hyphens/underscores with alphanumeric)
      if (index > 0 && /^[a-z0-9]+[-_][a-z0-9-_]+$/i.test(segment)) {
        return "{slug}";
      }

      // Check for segments that end with a number (like article-123, post-456)
      if (index > 0 && /^[a-z-_]+\d+$/i.test(segment)) {
        return "{slug-id}";
      }

      // Check for encoded segments or very long segments (likely dynamic)
      if (segment.length > 50 || /%[0-9A-F]{2}/i.test(segment)) {
        return "{dynamic}";
      }

      // Check for segments that look like date-based slugs (2024-01-15-article-title)
      if (/^\d{4}-\d{2}-\d{2}/.test(segment)) {
        return "{date-slug}";
      }

      // Check for hash-like segments (short random strings)
      if (
        index > 0 &&
        /^[a-z0-9]{6,12}$/i.test(segment) &&
        !/^[a-z]+$/i.test(segment)
      ) {
        return "{hash}";
      }

      // Keep the segment as-is (static path)
      return segment;
    });

    return parsed.origin + "/" + patternSegments.join("/");
  } catch {
    return url;
  }
}

// Check if a URL pattern has already been visited
function isPatternVisited(url, visitedPatterns) {
  const pattern = getUrlPattern(url);
  return visitedPatterns.has(pattern);
}

// Mark a URL pattern as visited
function markPatternVisited(url, visitedPatterns) {
  const pattern = getUrlPattern(url);
  visitedPatterns.add(pattern);
  return pattern;
}

// Check if URL is internal (same domain)
function isInternalUrl(baseUrl, testUrl) {
  try {
    const base = new URL(baseUrl);
    const test = new URL(testUrl, baseUrl);
    return base.hostname === test.hostname;
  } catch {
    return false;
  }
}

// Extract links from page
async function extractLinks(page, baseUrl) {
  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll("a[href]");
    return Array.from(anchors).map((a) => a.href);
  });

  // Filter to only internal links and normalize
  const internalLinks = links
    .filter((link) => isInternalUrl(baseUrl, link))
    .filter((link) => {
      try {
        const url = new URL(link);
        // Skip anchors, javascript, mailto, tel links
        return (
          !url.href.includes("#") &&
          !url.protocol.includes("javascript") &&
          !url.protocol.includes("mailto") &&
          !url.protocol.includes("tel")
        );
      } catch {
        return false;
      }
    })
    .map((link) => normalizeUrl(link));

  return [...new Set(internalLinks)];
}

// Take full page screenshot with scrolling
async function takeFullPageScreenshot(page, filepath, options = {}) {
  const { scrollDelay = 100 } = options;

  // Scroll through the page to trigger lazy loading
  await page.evaluate(async (delay) => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, delay);
    });
  }, scrollDelay);

  // Wait a bit for any final renders
  await new Promise((r) => setTimeout(r, 500));

  // Take full page screenshot
  await page.screenshot({
    path: filepath,
    fullPage: true,
    type: "png",
  });
}

// Ensure videos directory exists
const videosDir = path.join(__dirname, "videos");
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

// Record video of page with scrolling
async function recordPageVideo(page, filepath, options = {}, socket = null) {
  const {
    scrollSpeed = 50, // Pixels per frame
    frameRate = 30, // FPS
    videoDuration = "auto", // 'auto' or seconds
    pauseAtTop = 1000, // ms to pause at top
    pauseAtBottom = 1000, // ms to pause at bottom
  } = options;

  const tempDir = filepath.replace(".webm", "_frames");

  // Create temp frames directory
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  try {
    if (socket)
      socket.emit("status", {
        type: "info",
        message: "Starting video capture...",
      });

    // Get page dimensions
    const dimensions = await page.evaluate(() => ({
      scrollHeight: document.body.scrollHeight,
      clientHeight: window.innerHeight,
      scrollWidth: document.body.scrollWidth,
    }));

    const totalScroll = dimensions.scrollHeight - dimensions.clientHeight;
    const frameDelay = 1000 / frameRate;

    let frameCount = 0;

    // Scroll to top first
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 500));

    // Capture frames at the top (pause)
    const framesAtPause = Math.ceil((pauseAtTop / 1000) * frameRate);
    for (let i = 0; i < framesAtPause; i++) {
      const framePath = path.join(
        tempDir,
        `frame_${String(frameCount).padStart(6, "0")}.png`
      );
      await page.screenshot({ path: framePath, type: "png" });
      frameCount++;
    }

    if (socket)
      socket.emit("status", {
        type: "info",
        message: "Capturing scroll frames...",
      });

    // Calculate frames needed for scrolling
    const scrollFrames = Math.ceil(totalScroll / scrollSpeed);

    for (let i = 0; i <= scrollFrames; i++) {
      const scrollY = Math.min(i * scrollSpeed, totalScroll);

      await page.evaluate((y) => window.scrollTo(0, y), scrollY);
      await new Promise((r) => setTimeout(r, frameDelay / 2)); // Small delay for render

      const framePath = path.join(
        tempDir,
        `frame_${String(frameCount).padStart(6, "0")}.png`
      );
      await page.screenshot({ path: framePath, type: "png" });
      frameCount++;

      // Progress update every 20 frames
      if (socket && i % 20 === 0) {
        const progress = Math.round((i / scrollFrames) * 100);
        socket.emit("video-progress", { progress, frames: frameCount });
      }
    }

    // Capture frames at the bottom (pause)
    for (let i = 0; i < framesAtPause; i++) {
      const framePath = path.join(
        tempDir,
        `frame_${String(frameCount).padStart(6, "0")}.png`
      );
      await page.screenshot({ path: framePath, type: "png" });
      frameCount++;
    }

    if (socket)
      socket.emit("status", {
        type: "info",
        message: `Captured ${frameCount} frames. Encoding video...`,
      });

    // Encode video with ffmpeg
    await new Promise((resolve, reject) => {
      const ffmpegArgs = [
        "-y", // Overwrite output
        "-framerate",
        String(frameRate), // Input framerate
        "-i",
        path.join(tempDir, "frame_%06d.png"), // Input pattern
        "-c:v",
        "libvpx-vp9", // VP9 codec for WebM
        "-b:v",
        "2M", // Bitrate
        "-pix_fmt",
        "yuva420p", // Pixel format
        "-auto-alt-ref",
        "0", // For better compatibility
        filepath, // Output file
      ];

      const ffmpeg = spawn(ffmpegPath, ffmpegArgs);

      let stderr = "";
      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Try fallback with simpler encoding
          if (socket)
            socket.emit("status", {
              type: "warning",
              message: "Trying alternative encoding...",
            });

          const fallbackArgs = [
            "-y",
            "-framerate",
            String(frameRate),
            "-i",
            path.join(tempDir, "frame_%06d.png"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            filepath.replace(".webm", ".mp4"),
          ];

          const ffmpegFallback = spawn(ffmpegPath, fallbackArgs);
          ffmpegFallback.on("close", (fallbackCode) => {
            if (fallbackCode === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `FFmpeg failed with code ${code}. Make sure ffmpeg is installed.`
                )
              );
            }
          });
        }
      });

      ffmpeg.on("error", (err) => {
        reject(
          new Error(
            `FFmpeg not found. Please install ffmpeg. Error: ${err.message}`
          )
        );
      });
    });

    if (socket)
      socket.emit("status", {
        type: "success",
        message: "Video encoding complete!",
      });

    // Clean up temp frames
    const frames = fs.readdirSync(tempDir);
    for (const frame of frames) {
      fs.unlinkSync(path.join(tempDir, frame));
    }
    fs.rmdirSync(tempDir);

    return { success: true, frameCount, filepath };
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(tempDir)) {
      try {
        const frames = fs.readdirSync(tempDir);
        for (const frame of frames) {
          fs.unlinkSync(path.join(tempDir, frame));
        }
        fs.rmdirSync(tempDir);
      } catch (e) {
        // ignore cleanup errors
      }
    }
    throw error;
  }
}

// Record video of a single URL
async function recordSinglePageVideo(sessionId, url, options, socket) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  const {
    viewport = { width: 1920, height: 1080 },
    pageTimeout = 30000,
    waitAfterLoad = 2000,
    scrollSpeed = 50,
    frameRate = 30,
    pauseAtTop = 1000,
    pauseAtBottom = 1000,
  } = options;

  const sessionDir = path.join(videosDir, sessionId);

  // Create session directory
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  let browser;
  try {
    socket.emit("status", { type: "info", message: "Launching browser..." });

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport(viewport);

    socket.emit("status", { type: "info", message: `Navigating to: ${url}` });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: pageTimeout,
    });

    // Wait for dynamic content
    await new Promise((r) => setTimeout(r, waitAfterLoad));

    // Get page title
    const title = await page.title();
    socket.emit("status", {
      type: "info",
      message: `Recording: ${title || url}`,
    });

    // Generate video filename
    const filename = `video_${Date.now()}.webm`;
    const filepath = path.join(sessionDir, filename);

    // Record the video
    const result = await recordPageVideo(
      page,
      filepath,
      {
        scrollSpeed,
        frameRate,
        pauseAtTop,
        pauseAtBottom,
      },
      socket
    );

    // Check if mp4 fallback was used
    let finalFilename = filename;
    let finalFilepath = filepath;
    if (
      !fs.existsSync(filepath) &&
      fs.existsSync(filepath.replace(".webm", ".mp4"))
    ) {
      finalFilename = filename.replace(".webm", ".mp4");
      finalFilepath = filepath.replace(".webm", ".mp4");
    }

    // Get file size
    const stats = fs.statSync(finalFilepath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    const videoResult = {
      url,
      title: title || "Untitled",
      video: `/videos/${sessionId}/${finalFilename}`,
      frames: result.frameCount,
      fileSize: `${fileSizeMB} MB`,
      timestamp: new Date().toISOString(),
    };

    socket.emit("video-complete", videoResult);

    // Save summary
    const summaryPath = path.join(sessionDir, "summary.json");
    fs.writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          url,
          options,
          startTime: session.startTime,
          endTime: new Date().toISOString(),
          result: videoResult,
        },
        null,
        2
      )
    );
  } catch (error) {
    socket.emit("status", {
      type: "error",
      message: `Video recording error: ${error.message}`,
    });
    socket.emit("video-error", { error: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
    activeSessions.delete(sessionId);
  }
}

// Main crawl function
async function crawlWebsite(sessionId, startUrl, options, socket) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  const {
    maxPages = 50,
    viewport = { width: 1920, height: 1080 },
    scrollDelay = 100,
    pageTimeout = 30000,
    waitAfterLoad = 1000,
    smartDedup = false, // Smart URL pattern deduplication
  } = options;

  const visited = new Set();
  const visitedPatterns = new Set(); // Track URL patterns for smart dedup
  const skippedUrls = []; // Track skipped URLs for reporting
  const queue = [normalizeUrl(startUrl)];
  const results = [];
  const sessionDir = path.join(screenshotsDir, sessionId);

  // Create session directory
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  let browser;
  try {
    socket.emit("status", { type: "info", message: "Launching browser..." });

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport(viewport);

    while (queue.length > 0 && visited.size < maxPages && !session.cancelled) {
      const currentUrl = queue.shift();

      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      const pageNumber = visited.size;
      socket.emit("progress", {
        current: pageNumber,
        total: Math.min(queue.length + visited.size, maxPages),
        url: currentUrl,
        status: "processing",
      });

      try {
        socket.emit("status", {
          type: "info",
          message: `Navigating to: ${currentUrl}`,
        });

        await page.goto(currentUrl, {
          waitUntil: "networkidle2",
          timeout: pageTimeout,
        });

        // Wait additional time for dynamic content
        await new Promise((r) => setTimeout(r, waitAfterLoad));

        // Get page title
        const title = await page.title();

        // Extract internal links
        const links = await extractLinks(page, startUrl);

        // Mark current URL's pattern as visited (for smart dedup)
        if (smartDedup) {
          const pattern = markPatternVisited(currentUrl, visitedPatterns);
          socket.emit("status", {
            type: "info",
            message: `Pattern detected: ${pattern}`,
          });
        }

        links.forEach((link) => {
          if (!visited.has(link) && !queue.includes(link)) {
            // Smart deduplication: skip if we've already seen this pattern
            if (smartDedup && isPatternVisited(link, visitedPatterns)) {
              const pattern = getUrlPattern(link);
              skippedUrls.push({
                url: link,
                pattern,
                reason: "duplicate_pattern",
              });
              socket.emit("status", {
                type: "warning",
                message: `Skipped (same pattern): ${link}`,
              });
              return;
            }
            queue.push(link);
          }
        });

        // Take screenshot
        const filename = `page_${pageNumber}.png`;
        const filepath = path.join(sessionDir, filename);

        socket.emit("status", {
          type: "info",
          message: `Taking screenshot of: ${title || currentUrl}`,
        });

        await takeFullPageScreenshot(page, filepath, { scrollDelay });

        const result = {
          id: pageNumber,
          url: currentUrl,
          title: title || "Untitled",
          screenshot: `/screenshots/${sessionId}/${filename}`,
          linksFound: links.length,
          timestamp: new Date().toISOString(),
        };

        results.push(result);
        socket.emit("screenshot", result);

        socket.emit("status", {
          type: "success",
          message: `Completed: ${title || currentUrl}`,
        });
      } catch (error) {
        socket.emit("status", {
          type: "error",
          message: `Failed to capture ${currentUrl}: ${error.message}`,
        });
        results.push({
          id: pageNumber,
          url: currentUrl,
          title: "Error",
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    socket.emit("status", {
      type: "error",
      message: `Crawl error: ${error.message}`,
    });
  } finally {
    if (browser) {
      await browser.close();
    }

    // Save results summary
    const summaryPath = path.join(sessionDir, "summary.json");
    fs.writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          startUrl,
          options,
          startTime: session.startTime,
          endTime: new Date().toISOString(),
          pagesProcessed: results.length,
          patternsFound: smartDedup ? visitedPatterns.size : null,
          skippedDuplicates: smartDedup ? skippedUrls.length : null,
          skippedUrls: smartDedup ? skippedUrls : null,
          results,
        },
        null,
        2
      )
    );

    socket.emit("complete", {
      sessionId,
      totalPages: results.length,
      results,
    });

    activeSessions.delete(sessionId);
  }
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("start-crawl", (data) => {
    const { url, options = {} } = data;

    if (!url) {
      socket.emit("status", { type: "error", message: "URL is required" });
      return;
    }

    const sessionId = generateSessionId(url);
    const session = {
      id: sessionId,
      url,
      options,
      startTime: new Date().toISOString(),
      cancelled: false,
    };

    activeSessions.set(sessionId, session);
    socket.emit("session-started", { sessionId, domain: getDomainName(url) });

    // Start crawling
    crawlWebsite(sessionId, url, options, socket);
  });

  socket.on("cancel-crawl", (data) => {
    const { sessionId } = data;
    const session = activeSessions.get(sessionId);
    if (session) {
      session.cancelled = true;
      socket.emit("status", {
        type: "warning",
        message: "Crawl cancelled by user",
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });

  // Video recording socket event
  socket.on("start-video", (data) => {
    const { url, options = {} } = data;

    if (!url) {
      socket.emit("status", { type: "error", message: "URL is required" });
      return;
    }

    const sessionId = generateSessionId(url) + "_video";
    const session = {
      id: sessionId,
      url,
      options,
      startTime: new Date().toISOString(),
      type: "video",
    };

    activeSessions.set(sessionId, session);
    socket.emit("video-session-started", {
      sessionId,
      domain: getDomainName(url),
    });

    // Start video recording
    recordSinglePageVideo(sessionId, url, options, socket);
  });
});

// API endpoint to list previous sessions
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = fs
      .readdirSync(screenshotsDir)
      .filter((dir) =>
        fs.statSync(path.join(screenshotsDir, dir)).isDirectory()
      )
      .map((dir) => {
        const summaryPath = path.join(screenshotsDir, dir, "summary.json");
        if (fs.existsSync(summaryPath)) {
          const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
          return {
            sessionId: dir,
            ...summary,
          };
        }
        return { sessionId: dir };
      })
      .sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));

    res.json(sessions);
  } catch (error) {
    res.json([]);
  }
});

// API endpoint to get session details
app.get("/api/sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const summaryPath = path.join(screenshotsDir, sessionId, "summary.json");

  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    res.json(summary);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// API endpoint to delete a session
app.delete("/api/sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const sessionDir = path.join(screenshotsDir, sessionId);

  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// API endpoint to download all screenshots as ZIP
app.get("/api/sessions/:sessionId/download", async (req, res) => {
  const { sessionId } = req.params;
  const sessionDir = path.join(screenshotsDir, sessionId);

  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: "Session not found" });
  }

  try {
    // Set up response headers for ZIP download
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sessionId}-screenshots.zip"`
    );

    // Create archive
    const archive = archiver("zip", {
      zlib: { level: 6 }, // Compression level
    });

    // Pipe archive to response
    archive.pipe(res);

    // Handle archive errors
    archive.on("error", (err) => {
      console.error("Archive error:", err);
      res.status(500).json({ error: "Failed to create archive" });
    });

    // Get all PNG files in session directory
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".png"));

    // Add each file to archive
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      archive.file(filePath, { name: file });
    }

    // Also add summary.json if it exists
    const summaryPath = path.join(sessionDir, "summary.json");
    if (fs.existsSync(summaryPath)) {
      archive.file(summaryPath, { name: "summary.json" });
    }

    // Finalize the archive
    await archive.finalize();
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({ error: "Failed to prepare download" });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(
    `🚀 Website Screenshot Crawler running at http://localhost:${PORT}`
  );
});
