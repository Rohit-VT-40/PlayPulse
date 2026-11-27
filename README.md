# PlayPulse Intelligence 🎮⚡
> **Google Play Game Analytics & Real-Time Market Intelligence Dashboard**

PlayPulse Intelligence is a full-featured market analytics and competitor intelligence suite designed for mobile game developers, publishers, and product managers. It pulls live, verified data directly from the Google Play Store to track game catalogs, market trends, fresh competitor releases, and game-specific retention/download velocity.

---

## 🚀 Quick Start (How to Run)

Follow these simple steps to run this project on any system (Windows, macOS, or Linux):

### 1. Prerequisites
- **Node.js**: Make sure Node.js (version 18 or higher) is installed on your system.  
  Check with:
  ```bash
  node -v
  npm -v
  ```

### 2. Enter PlayPulse Folder & Install Dependencies
Open your terminal inside the cloned project repository and run:
```bash
cd PlayPulse
npm install
```

### 3. Start the Server
Start the local server with:
```bash
npm start
```

### 4. Open the Dashboard in Your Browser
Once the server starts, open your browser and go to:
```
http://localhost:3000
```

---

## 🌟 Key Features

### 1. 🏢 Publisher Catalog Intelligence
- Search any mobile game publisher (e.g. `Lion Studios`, `Voodoo`, `SayGames`, `Supercell`, `Ketchapp`).
- Live metrics: Total Titles, Cumulative Downloads, Average Rating, Total Reviews, Dominant Category.
- Filter by category, search by title keywords, and sort by Downloads, Score, Reviews, or Release Date.
- Uncapped deep indexing modes: Standard (~400), Extended (~800), Deep (~1500), and Full Universe.

### 2. 📈 Trending & Top Charts
- Live Top Free, Top Grossing, and Top Paid store charts across 8 countries (🇺🇸 US, 🇮🇳 India, 🇬🇧 UK, 🇯🇵 Japan, 🇰🇷 South Korea, etc.).
- Genre-specific breakdowns (Puzzle, Action, Arcade, Casual, Strategy, Simulation).

### 3. 🎯 Launch Radar & Competitor Watchlist
- Real-time scanner tracking 27+ top mobile gaming studios for new game releases.
- Timeframe filters: Last 24 Hours (Today), Past 7 Days, Past 30 Days, Past 12 Months, or Custom Date Range.
- Quick alphabetized studio navigation sidebar with one-click filtering.

### 4. 📊 Game-Specific Performance & Velocity Analytics
Clicking on any game card opens the modal directly to the **Performance & Velocity** tab:
- **Active Players (DAU)**: Estimated daily active users and % of userbase.
- **Monthly Active Players (MAU)**: Estimated 30-day active player retention.
- **Inactive / Churned Users**: Total uninstalled/dormant users and churn percentage.
- **Download Momentum Badge**: Automatic trend detection (`🔥 Surging`, `🟢 Steady`, `🔻 Cooling`).
- **12-Week Interactive Velocity Trend Chart**: Smooth SVG curve showing weekly download volume and moving trend over the past 12 weeks with hover tooltips.
- **Category Benchmarks & Monetization Split**: Genre retention rates (D1, D7, D30) and revenue breakdown (Ads vs. IAP).

### 5. 💬 Live Review Mining & Sentiment
- Real-time Google Play user reviews with developer response tracking, user avatars, and star ratings.

### 6. 📥 Export to CSV
- One-click dataset export containing package IDs, estimated downloads, release dates, ratings, and store links.

---

## 🛠️ Tech Stack
- **Backend**: Node.js, Express 5 (ES Modules)
- **Scraper / Store Engine**: `google-play-scraper`
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, Modern CSS (Responsive, Dark Theme, Custom SVG Charts)
- **Zero Heavy Framework Lock-in**: Starts in < 1 second with no heavy build step required.

---

## 📁 Project Structure
```text
PlayPulse/
├── data/
│   └── watchlist.json       # Monitored competitor game studios
├── public/
│   ├── index.html           # Main dashboard interface
│   ├── style.css            # SaaS design system & responsive styling
│   └── app.js               # Client state, SVG chart engine, API integration
├── server.mjs               # Express API proxy & scraper integration
├── package.json             # NPM dependencies & startup scripts
├── .gitignore               # Excluded files (node_modules, logs)
└── README.md                # Project documentation
```
