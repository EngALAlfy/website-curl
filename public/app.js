// Initialize Socket.io connection
const socket = io();

// DOM Elements
const crawlForm = document.getElementById('crawl-form');
const websiteUrlInput = document.getElementById('website-url');
const maxPagesInput = document.getElementById('max-pages');
const viewportWidthSelect = document.getElementById('viewport-width');
const scrollDelayInput = document.getElementById('scroll-delay');
const pageTimeoutInput = document.getElementById('page-timeout');
const waitAfterLoadInput = document.getElementById('wait-after-load');
const smartDedupCheckbox = document.getElementById('smart-dedup');
const startBtn = document.getElementById('start-btn');
const cancelBtn = document.getElementById('cancel-btn');
const progressPanel = document.getElementById('progress-panel');
const progressBar = document.getElementById('progress-bar');
const pagesCount = document.getElementById('pages-count');
const pagesTotal = document.getElementById('pages-total');
const currentUrl = document.getElementById('current-url');
const statusLog = document.getElementById('status-log');
const clearLogBtn = document.getElementById('clear-log-btn');
const screenshotsPanel = document.getElementById('screenshots-panel');
const screenshotsGrid = document.getElementById('screenshots-grid');
const screenshotCount = document.getElementById('screenshot-count');
const historyList = document.getElementById('history-list');
const refreshHistoryBtn = document.getElementById('refresh-history-btn');
const modal = document.getElementById('screenshot-modal');
const modalTitle = document.getElementById('modal-title');
const modalUrl = document.getElementById('modal-url');
const modalImage = document.getElementById('modal-image');
const modalDownload = document.getElementById('modal-download');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalBackdrop = document.querySelector('.modal-backdrop');

// State
let currentSessionId = null;
let isCrawling = false;

// Tab Navigation
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;

        // Update tab buttons
        document.querySelectorAll('.nav-tab').forEach(t => {
            t.classList.remove('active', 'bg-primary-500/20', 'text-primary-400');
            t.classList.add('text-dark-400', 'hover:text-dark-200');
        });
        tab.classList.add('active', 'bg-primary-500/20', 'text-primary-400');
        tab.classList.remove('text-dark-400', 'hover:text-dark-200');

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.add('hidden');
        });
        document.getElementById(`${targetTab}-tab`).classList.remove('hidden');

        // Load history when switching to history tab
        if (targetTab === 'history') {
            loadHistory();
        }
    });
});

// Initialize active tab styling
document.querySelector('.nav-tab.active').classList.add('bg-primary-500/20', 'text-primary-400');

// Form submission
crawlForm.addEventListener('submit', (e) => {
    e.preventDefault();

    if (isCrawling) return;

    const url = websiteUrlInput.value.trim();
    if (!url) {
        addLogEntry('error', 'Please enter a valid URL');
        return;
    }

    // Validate URL
    try {
        new URL(url);
    } catch {
        addLogEntry('error', 'Invalid URL format. Please include http:// or https://');
        return;
    }

    const options = {
        maxPages: parseInt(maxPagesInput.value) || 20,
        viewport: {
            width: parseInt(viewportWidthSelect.value) || 1920,
            height: 1080
        },
        scrollDelay: parseInt(scrollDelayInput.value) || 100,
        pageTimeout: (parseInt(pageTimeoutInput.value) || 30) * 1000,
        waitAfterLoad: parseInt(waitAfterLoadInput.value) || 1000,
        smartDedup: smartDedupCheckbox.checked
    };

    // Clear previous results
    screenshotsGrid.innerHTML = '';
    screenshotCount.textContent = '0';

    // Start crawling
    socket.emit('start-crawl', { url, options });

    // Update UI state
    setCrawlingState(true);
    addLogEntry('info', `Starting crawl of ${url}`);
});

// Cancel button
cancelBtn.addEventListener('click', () => {
    if (currentSessionId) {
        socket.emit('cancel-crawl', { sessionId: currentSessionId });
        addLogEntry('warning', 'Cancelling crawl...');
    }
});

// Clear log button
clearLogBtn.addEventListener('click', () => {
    statusLog.innerHTML = `
        <div class="log-entry flex items-start gap-3 text-sm">
            <span class="text-dark-500 font-mono">--:--:--</span>
            <span class="text-dark-400">Log cleared. Ready to start crawling...</span>
        </div>
    `;
});

// Socket event handlers
socket.on('session-started', (data) => {
    currentSessionId = data.sessionId;
    addLogEntry('success', `Session started: ${data.sessionId.substring(0, 8)}...`);
});

socket.on('status', (data) => {
    addLogEntry(data.type, data.message);
});

socket.on('progress', (data) => {
    pagesCount.textContent = data.current;
    pagesTotal.textContent = data.total;
    currentUrl.textContent = data.url;

    const percentage = (data.current / data.total) * 100;
    progressBar.style.width = `${percentage}%`;
});

socket.on('screenshot', (data) => {
    addScreenshotCard(data);
    const count = parseInt(screenshotCount.textContent) + 1;
    screenshotCount.textContent = count;
    screenshotsPanel.classList.remove('hidden');
});

socket.on('complete', (data) => {
    setCrawlingState(false);
    addLogEntry('success', `Crawl completed! Captured ${data.totalPages} pages.`);
    currentSessionId = null;
});

socket.on('connect_error', () => {
    addLogEntry('error', 'Connection error. Please check if the server is running.');
});

// Helper functions
function setCrawlingState(crawling) {
    isCrawling = crawling;
    startBtn.disabled = crawling;
    cancelBtn.disabled = !crawling;
    websiteUrlInput.disabled = crawling;

    if (crawling) {
        progressPanel.classList.remove('hidden');
        startBtn.innerHTML = `
            <svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            Crawling...
        `;
        startBtn.classList.add('opacity-70', 'cursor-not-allowed');
    } else {
        startBtn.innerHTML = `
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Start Crawling
        `;
        startBtn.classList.remove('opacity-70', 'cursor-not-allowed');
    }
}

function addLogEntry(type, message) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false });

    const colorClasses = {
        info: 'text-primary-400',
        success: 'text-emerald-400',
        warning: 'text-amber-400',
        error: 'text-red-400'
    };

    const icons = {
        info: '●',
        success: '✓',
        warning: '⚠',
        error: '✕'
    };

    const entry = document.createElement('div');
    entry.className = 'log-entry flex items-start gap-3 text-sm animate-fade-in';
    entry.innerHTML = `
        <span class="text-dark-500 font-mono">${time}</span>
        <span class="${colorClasses[type]} flex items-center gap-2">
            <span>${icons[type]}</span>
            ${escapeHtml(message)}
        </span>
    `;

    statusLog.appendChild(entry);
    statusLog.scrollTop = statusLog.scrollHeight;
}

function addScreenshotCard(data) {
    const card = document.createElement('div');
    card.className = 'screenshot-card group relative bg-dark-800/50 rounded-xl overflow-hidden border border-dark-700/50 cursor-pointer';
    card.innerHTML = `
        <div class="aspect-video relative overflow-hidden">
            <img src="${data.screenshot}" alt="${escapeHtml(data.title)}" class="w-full h-full object-cover object-top">
            <div class="absolute inset-0 bg-gradient-to-t from-dark-900/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                <span class="text-xs text-white font-medium truncate">${escapeHtml(data.title)}</span>
            </div>
        </div>
        <div class="p-3">
            <p class="text-sm font-medium text-white truncate">${escapeHtml(data.title)}</p>
            <p class="text-xs text-dark-400 truncate mt-1">${escapeHtml(data.url)}</p>
            <div class="flex items-center gap-2 mt-2">
                <span class="text-xs text-dark-500">${data.linksFound || 0} links found</span>
            </div>
        </div>
    `;

    card.addEventListener('click', () => openModal(data));
    screenshotsGrid.appendChild(card);
}

function openModal(data) {
    modalTitle.textContent = data.title;
    modalUrl.href = data.url;
    modalUrl.textContent = data.url;
    modalImage.src = data.screenshot;
    modalDownload.href = data.screenshot;
    modalDownload.download = `screenshot_${data.id}.png`;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
}

modalCloseBtn.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeModal();
    }
});

// History functions
async function loadHistory() {
    try {
        const response = await fetch('/api/sessions');
        const sessions = await response.json();

        if (sessions.length === 0) {
            historyList.innerHTML = `
                <div class="empty-state flex flex-col items-center justify-center py-12 text-center">
                    <svg class="w-16 h-16 text-dark-600 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                    </svg>
                    <p class="text-dark-400 font-medium">No previous sessions found</p>
                    <span class="text-sm text-dark-500">Start a new crawl to see history here</span>
                </div>
            `;
            return;
        }

        historyList.innerHTML = sessions.map(session => `
            <div class="session-card bg-dark-800/50 rounded-xl p-4 border border-dark-700/50 mb-3 hover:border-dark-600/50 transition-colors">
                <div class="flex items-start justify-between gap-4">
                    <div class="flex-1 min-w-0">
                        <h4 class="font-medium text-white truncate">${escapeHtml(session.startUrl || 'Unknown URL')}</h4>
                        <p class="text-sm text-dark-400 mt-1">
                            ${session.pagesProcessed || 0} pages • 
                            ${formatDate(session.startTime)}
                        </p>
                    </div>
                    <div class="flex items-center gap-2">
                        <a href="/screenshots/${session.sessionId}/" target="_blank" class="px-3 py-1.5 text-sm bg-primary-500/20 text-primary-400 rounded-lg hover:bg-primary-500/30 transition-colors">
                            View
                        </a>
                        <button onclick="deleteSession('${session.sessionId}')" class="px-3 py-1.5 text-sm bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors">
                            Delete
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (error) {
        addLogEntry('error', 'Failed to load history');
    }
}

async function deleteSession(sessionId) {
    if (!confirm('Are you sure you want to delete this session?')) return;

    try {
        await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
        loadHistory();
    } catch (error) {
        addLogEntry('error', 'Failed to delete session');
    }
}

refreshHistoryBtn.addEventListener('click', loadHistory);

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    if (!dateString) return 'Unknown date';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Make deleteSession available globally
window.deleteSession = deleteSession;
