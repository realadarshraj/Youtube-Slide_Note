const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'view-source:',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com'
];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url) return;
  if (RESTRICTED_PREFIXES.some(prefix => tab.url.startsWith(prefix))) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_OVERLAY' });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['lib/jspdf.umd.min.js', 'content.js']
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_OVERLAY', forceShow: true }).catch(() => {});
      }, 150);
    } catch (_) {
      // Ignore pages where script injection is disallowed by browser policy
    }
  }
});
