# Contributing to Claims Data Exporter

Thank you for considering contributing! This is a community-driven project.

## 🎯 Project Goals

- Help users export their own claims data
- Support multiple claims platforms
- Maintain security and privacy
- Stay open source and transparent

## 🔧 How to Contribute

### Reporting Bugs

1. Check if the bug is already reported
2. Include:
   - Chrome version
   - Platform you're exporting from
   - Steps to reproduce
   - Expected vs actual behavior
   - Console errors (if any)

### Suggesting Features

1. Describe the feature
2. Explain the use case
3. Provide examples if possible

### Code Contributions

1. **Fork the repo**
2. **Create a branch**: `git checkout -b feature/your-feature`
3. **Make changes**
4. **Test thoroughly**
5. **Submit PR**

## 📝 Code Guidelines

### File Structure

```
chrome-extension/
├── manifest.json       # Extension config
├── popup.html          # Extension UI
├── popup.js            # UI logic
├── content-script.js   # Main processing
├── background.js       # Service worker
├── icons/              # Extension icons
└── README.md           # Documentation
```

### Coding Style

- Use clear variable names
- Add comments for complex logic
- Follow existing code style
- Keep functions small and focused

### Adding Support for New Platforms

To add support for a new claims platform:

1. **Update `content-script.js`**:
   ```javascript
   // Add platform detection
   if (window.location.hostname.includes('newplatform.com')) {
     // Platform-specific logic
   }
   ```

2. **Add API endpoint patterns**:
   ```javascript
   const endpoints = {
     search: '/api/search',
     details: '/api/claim/{id}',
     // etc.
   };
   ```

3. **Test with real data**

4. **Document in README**

## 🧪 Testing

Before submitting:

- [ ] Tested with test mode (1 claim)
- [ ] Tested with multiple claims
- [ ] No console errors
- [ ] JSON validates
- [ ] Existing functionality not broken

## ⚖️ Legal Considerations

- Ensure changes don't violate platform ToS
- Don't include copyrighted material
- Don't bypass authentication
- Respect rate limits
- User must be logged in

## 📄 License

By contributing, you agree your contributions will be licensed under the MIT License.

## ❓ Questions?

Open an issue or contact the maintainers.

---

**Thank you for contributing!**

