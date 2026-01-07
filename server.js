const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// Ensure screenshots directory exists
const screenshotsDir = path.join(__dirname, 'screenshots');
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
        let normalized = parsed.origin + parsed.pathname.replace(/\/$/, '') + parsed.search;
        return normalized;
    } catch {
        return url;
    }
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
        const anchors = document.querySelectorAll('a[href]');
        return Array.from(anchors).map(a => a.href);
    });

    // Filter to only internal links and normalize
    const internalLinks = links
        .filter(link => isInternalUrl(baseUrl, link))
        .filter(link => {
            try {
                const url = new URL(link);
                // Skip anchors, javascript, mailto, tel links
                return !url.href.includes('#') &&
                       !url.protocol.includes('javascript') &&
                       !url.protocol.includes('mailto') &&
                       !url.protocol.includes('tel');
            } catch {
                return false;
            }
        })
        .map(link => normalizeUrl(link));

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
    await new Promise(r => setTimeout(r, 500));

    // Take full page screenshot
    await page.screenshot({
        path: filepath,
        fullPage: true,
        type: 'png'
    });
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
        waitAfterLoad = 1000
    } = options;

    const visited = new Set();
    const queue = [normalizeUrl(startUrl)];
    const results = [];
    const sessionDir = path.join(screenshotsDir, sessionId);

    // Create session directory
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    let browser;
    try {
        socket.emit('status', { type: 'info', message: 'Launching browser...' });

        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setViewport(viewport);

        while (queue.length > 0 && visited.size < maxPages && !session.cancelled) {
            const currentUrl = queue.shift();

            if (visited.has(currentUrl)) continue;
            visited.add(currentUrl);

            const pageNumber = visited.size;
            socket.emit('progress', {
                current: pageNumber,
                total: Math.min(queue.length + visited.size, maxPages),
                url: currentUrl,
                status: 'processing'
            });

            try {
                socket.emit('status', { type: 'info', message: `Navigating to: ${currentUrl}` });

                await page.goto(currentUrl, {
                    waitUntil: 'networkidle2',
                    timeout: pageTimeout
                });

                // Wait additional time for dynamic content
                await new Promise(r => setTimeout(r, waitAfterLoad));

                // Get page title
                const title = await page.title();

                // Extract internal links
                const links = await extractLinks(page, startUrl);
                links.forEach(link => {
                    if (!visited.has(link) && !queue.includes(link)) {
                        queue.push(link);
                    }
                });

                // Take screenshot
                const filename = `page_${pageNumber}.png`;
                const filepath = path.join(sessionDir, filename);

                socket.emit('status', { type: 'info', message: `Taking screenshot of: ${title || currentUrl}` });

                await takeFullPageScreenshot(page, filepath, { scrollDelay });

                const result = {
                    id: pageNumber,
                    url: currentUrl,
                    title: title || 'Untitled',
                    screenshot: `/screenshots/${sessionId}/${filename}`,
                    linksFound: links.length,
                    timestamp: new Date().toISOString()
                };

                results.push(result);
                socket.emit('screenshot', result);

                socket.emit('status', { type: 'success', message: `Completed: ${title || currentUrl}` });

            } catch (error) {
                socket.emit('status', { type: 'error', message: `Failed to capture ${currentUrl}: ${error.message}` });
                results.push({
                    id: pageNumber,
                    url: currentUrl,
                    title: 'Error',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }

    } catch (error) {
        socket.emit('status', { type: 'error', message: `Crawl error: ${error.message}` });
    } finally {
        if (browser) {
            await browser.close();
        }

        // Save results summary
        const summaryPath = path.join(sessionDir, 'summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify({
            startUrl,
            options,
            startTime: session.startTime,
            endTime: new Date().toISOString(),
            pagesProcessed: results.length,
            results
        }, null, 2));

        socket.emit('complete', {
            sessionId,
            totalPages: results.length,
            results
        });

        activeSessions.delete(sessionId);
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('start-crawl', (data) => {
        const { url, options = {} } = data;

        if (!url) {
            socket.emit('status', { type: 'error', message: 'URL is required' });
            return;
        }

        const sessionId = uuidv4();
        const session = {
            id: sessionId,
            url,
            options,
            startTime: new Date().toISOString(),
            cancelled: false
        };

        activeSessions.set(sessionId, session);
        socket.emit('session-started', { sessionId });

        // Start crawling
        crawlWebsite(sessionId, url, options, socket);
    });

    socket.on('cancel-crawl', (data) => {
        const { sessionId } = data;
        const session = activeSessions.get(sessionId);
        if (session) {
            session.cancelled = true;
            socket.emit('status', { type: 'warning', message: 'Crawl cancelled by user' });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// API endpoint to list previous sessions
app.get('/api/sessions', (req, res) => {
    try {
        const sessions = fs.readdirSync(screenshotsDir)
            .filter(dir => fs.statSync(path.join(screenshotsDir, dir)).isDirectory())
            .map(dir => {
                const summaryPath = path.join(screenshotsDir, dir, 'summary.json');
                if (fs.existsSync(summaryPath)) {
                    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
                    return {
                        sessionId: dir,
                        ...summary
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
app.get('/api/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const summaryPath = path.join(screenshotsDir, sessionId, 'summary.json');

    if (fs.existsSync(summaryPath)) {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        res.json(summary);
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

// API endpoint to delete a session
app.delete('/api/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionDir = path.join(screenshotsDir, sessionId);

    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Website Screenshot Crawler running at http://localhost:${PORT}`);
});
