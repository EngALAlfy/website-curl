# 📸 ScreenCrawl - Website Screenshot Crawler

A powerful web-based tool that crawls websites and captures full-page screenshots of every internal page. Perfect for visual documentation, archival, testing, and auditing.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![Puppeteer](https://img.shields.io/badge/Puppeteer-21+-blue?logo=puppeteer)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Features

- 🔗 **Automatic Link Discovery** - Crawls all internal links on your website
- 📸 **Full-Page Screenshots** - Captures entire pages with scroll support for lazy-loaded content
- 🎨 **Beautiful Web UI** - Modern glassmorphism design with Tailwind CSS
- ⚡ **Real-time Progress** - Live updates via Socket.io
- 📱 **Responsive Viewports** - Desktop, laptop, tablet, and mobile screenshot options
- 📁 **Session History** - Browse and manage previous crawl sessions
- ⚙️ **Configurable Settings** - Max pages, scroll delay, timeouts, and more
- 💾 **Download Screenshots** - Save individual screenshots or browse the gallery

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- npm (comes with Node.js)

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/ialalfy/website-curl.git
   cd website-curl
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start the server**

   ```bash
   npm start
   ```

4. **Open your browser**
   ```
   http://localhost:3000
   ```

## 🎯 Usage

1. Enter the **website URL** you want to crawl (e.g., `https://example.com`)
2. Configure your settings:
   - **Max Pages**: Maximum number of pages to capture (1-100)
   - **Viewport**: Screen width for screenshots (Desktop, Laptop, Tablet, Mobile)
   - **Scroll Delay**: Time between scroll steps for lazy-loading content
   - **Timeout**: Maximum wait time per page
   - **Wait After Load**: Extra time to wait after page load
3. Click **Start Crawling**
4. Watch the real-time progress and screenshot gallery
5. Click any screenshot to view full-size or download

## ⚙️ Configuration Options

| Option          | Default | Description                               |
| --------------- | ------- | ----------------------------------------- |
| Max Pages       | 20      | Maximum number of pages to crawl          |
| Viewport Width  | 1920px  | Screenshot width (Desktop)                |
| Scroll Delay    | 100ms   | Delay between scroll steps                |
| Page Timeout    | 30s     | Maximum time to wait for page load        |
| Wait After Load | 1000ms  | Additional wait time after page is loaded |

## 📁 Project Structure

```
website-curl/
├── server.js           # Express server with Puppeteer crawler
├── package.json        # Dependencies and scripts
├── public/
│   ├── index.html      # Web UI with Tailwind CSS
│   └── app.js          # Frontend JavaScript
├── screenshots/        # Generated screenshots (auto-created)
└── README.md
```

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **Browser Automation**: Puppeteer
- **Real-time Communication**: Socket.io
- **Frontend**: HTML5, Tailwind CSS v3, Vanilla JavaScript
- **Styling**: Glassmorphism, Animated Gradients, Dark Theme

## 🔧 API Endpoints

| Method | Endpoint            | Description                          |
| ------ | ------------------- | ------------------------------------ |
| GET    | `/api/sessions`     | List all previous crawl sessions     |
| GET    | `/api/sessions/:id` | Get details of a specific session    |
| DELETE | `/api/sessions/:id` | Delete a session and its screenshots |

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👤 Author

**Islam H Alalfy**

- Website: [alalfy.com](https://alalfy.com)
- GitHub: [@ialalfy](https://github.com/engalalfy)

---

<p align="center">
  Made with ❤️ by <a href="https://alalfy.com">Islam H Alalfy</a>
</p>
