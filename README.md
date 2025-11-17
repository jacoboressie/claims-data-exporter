# Claims Data Exporter

**Open-source Chrome extension for backing up your insurance claims data.**

Your data. Your backup. Your control.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why This Exists

We believe that users own their data and have the right to back it up. This is an open-source tool that gives you the ability to export and preserve your claims information from systems you have authorized access to.

No vendor lock-in. No proprietary formats. Just your data, when you need it.

## ⚡ Quick Start

### Installation

1. Download or clone this repo
2. Open Chrome → `chrome://extensions/`
3. Enable "Developer mode" (top-right toggle)
4. Click "Load unpacked"
5. Select the `claims-data-exporter` folder

### Usage

1. Log into your claims management system
2. Export CSV (Reports → "All Claims" → Export)
3. Click the extension icon in Chrome toolbar
4. Upload the CSV file
5. Wait for processing (shows progress)
6. Download the JSON file

## 🔒 Security & Privacy

- ✅ **No credentials stored** - uses your existing browser session
- ✅ **No data transmitted** - all processing happens locally in your browser
- ✅ **100% open source** - audit the code, no hidden functionality
- ✅ **You control everything** - what gets exported, when, and where it goes

## 📊 What Data Gets Exported

For each claim in the CSV:
- Main claim details
- Contacts
- Personnel (internal + external)
- Insurance & mortgage info
- Action items & tasks
- Financial ledger
- File metadata (not files themselves)
- Notes & activity history
- Phases & workflow

## 🛠️ Supported Platforms

Currently tested with:
- **ClaimWizard** (API endpoints mapped)

May work with other platforms that use similar API structures.

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md)

### Areas for Contribution

- Support for additional platforms
- Improved error handling
- Better UI/UX
- Bug fixes
- Documentation

## 📋 Technical Details

### How It Works

1. User uploads CSV with claim file numbers
2. Extension parses CSV to extract claim IDs
3. For each claim, makes API calls to fetch detailed data:
   - Claim details
   - Insurance information
   - Personnel
   - Action items
   - Ledger
   - Files (metadata only)
   - Notes
   - Activity
4. Aggregates into JSON format
5. User downloads JSON

### Rate Limiting

- 300ms delay between each API endpoint
- 500ms delay between claims
- Respects server resources
- Total time: ~4-6 seconds per claim

### File Structure

```
claims-data-exporter/
├── manifest.json       # Extension configuration
├── popup.html          # Extension UI
├── popup.js            # UI logic
├── content-script.js   # Main export logic
├── background.js       # Service worker
├── icons/              # Extension icons
├── wizard-down.png     # Logo
├── LICENSE             # MIT License
└── README.md           # This file
```

## 💡 Philosophy

This is an independent, community-driven tool built on the principle that users have the right to access and backup their own data. We're not affiliated with any claims management platform - we're simply providing an open-source way for users to exercise their data ownership rights.

Always ensure you have proper authorization to access the systems you're exporting from.

## 📄 License

MIT License - See [LICENSE](LICENSE) file.

This is an open source, community-maintained project.

## 📞 Links

- **GitHub**: https://github.com/jacoboressie/claims-data-exporter
- **Issues**: https://github.com/jacoboressie/claims-data-exporter/issues
- **License**: [MIT License](LICENSE)

---

**Your data belongs to you. This tool helps you keep it that way.**
