// Popup UI Controller with Step Wizard
let exportedData = null;
let uploadedFile = null;
let currentStep = 1;

document.addEventListener('DOMContentLoaded', async () => {
  // Load saved settings
  const settings = await chrome.storage.local.get(['testMode']);
  if (settings.testMode) document.getElementById('testMode').checked = true;

  // Check current state: completed export, in-progress, or error
  const stored = await chrome.storage.local.get([
    'exportedData', 'exportStats', 'exportProgress', 'exportError'
  ]);
  
  if (stored.exportedData) {
    // Export finished while popup was closed — show results
    exportedData = stored.exportedData;
    goToStep(4);
    showFinalStats(stored.exportStats);
  } else if (stored.exportProgress && stored.exportProgress.current != null) {
    // Export is still running — show progress step
    goToStep(3);
    updateProgress(
      stored.exportProgress.current,
      stored.exportProgress.total,
      stored.exportProgress.status
    );
  } else if (stored.exportError) {
    // Export failed while popup was closed
    goToStep(3);
    showProcessingError(stored.exportError);
    chrome.storage.local.remove(['exportError']);
  }

  // Check if user is on ClaimWizard
  checkClaimWizardStatus();

  // Step navigation
  document.getElementById('nextToUpload').addEventListener('click', () => goToStep(2));
  document.getElementById('backToPrepare').addEventListener('click', () => goToStep(1));
  document.getElementById('startOver').addEventListener('click', startOver);

  // File upload
  const uploadArea = document.getElementById('uploadArea');
  const csvUpload = document.getElementById('csvUpload');
  
  uploadArea.addEventListener('click', () => csvUpload.click());
  
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '#FF4D00';
  });
  
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.style.borderColor = '#e5e5e5';
  });
  
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '#e5e5e5';
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  
  csvUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
  });

  // Processing button
  document.getElementById('startProcessing').addEventListener('click', startProcessing);

  // Download button
  document.getElementById('downloadJson').addEventListener('click', downloadJson);

  // Test mode checkbox
  document.getElementById('testMode').addEventListener('change', (e) => {
    chrome.storage.local.set({ testMode: e.target.checked });
  });

  // Listen for progress updates via messages (when popup stays open)
  chrome.runtime.onMessage.addListener(handleExportProgress);

  // Also listen for storage changes (picks up progress when popup is reopened mid-export)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    
    if (changes.exportProgress && changes.exportProgress.newValue) {
      const p = changes.exportProgress.newValue;
      if (currentStep === 3 && p.current != null) {
        updateProgress(p.current, p.total, p.status);
      }
    }
    
    if (changes.exportedData && changes.exportedData.newValue) {
      exportedData = changes.exportedData.newValue;
      const stats = changes.exportStats?.newValue;
      if (stats) {
        goToStep(4);
        showFinalStats(stats);
      }
    }
    
    if (changes.exportError && changes.exportError.newValue) {
      showProcessingError(changes.exportError.newValue);
      chrome.storage.local.remove(['exportError']);
    }
  });
});

async function checkClaimWizardStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const statusBadge = document.getElementById('claimwizard-status');
    
    if (tab.url && tab.url.includes('claimwizard.com')) {
      statusBadge.classList.remove('hidden');
    }
  } catch (error) {
    console.error('Error checking ClaimWizard status:', error);
  }
}

function goToStep(step) {
  currentStep = step;
  
  // Update step indicators
  document.querySelectorAll('.step').forEach(el => {
    const stepNum = parseInt(el.dataset.step);
    const stepNumber = el.querySelector('.step-number');
    
    el.classList.remove('active', 'completed');
    
    if (stepNum < step) {
      el.classList.add('completed');
      stepNumber.textContent = '✓'; // Show checkmark for completed
    } else if (stepNum === step) {
      el.classList.add('active');
      stepNumber.textContent = stepNum; // Show number for active
    } else {
      stepNumber.textContent = stepNum; // Show number for future steps
    }
  });
  
  // Update content
  document.querySelectorAll('.step-content').forEach(el => {
    el.classList.remove('active');
  });
  document.querySelector(`.step-content[data-step="${step}"]`).classList.add('active');
}

function handleFile(file) {
  if (!file.name.endsWith('.csv')) {
    alert('Please upload a CSV file');
    return;
  }

  uploadedFile = file;
  
  // Update UI
  const uploadArea = document.getElementById('uploadArea');
  const fileInfo = document.getElementById('fileInfo');
  const fileName = document.getElementById('fileName');
  const startButton = document.getElementById('startProcessing');
  
  uploadArea.classList.add('has-file');
  fileInfo.classList.remove('hidden');
  fileName.textContent = file.name;
  startButton.disabled = false;
}

async function startProcessing() {
  if (!uploadedFile) {
    alert('Please select a CSV file first');
    return;
  }

  // Move to processing step
  goToStep(3);

  try {
    const csvText = await uploadedFile.text();
    
    // Check if we're on ClaimWizard
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes('claimwizard.com')) {
      showProcessingError('Please open ClaimWizard in this tab first!');
      return;
    }

    const testMode = document.getElementById('testMode').checked;

    // Send CSV to content script for processing
    chrome.tabs.sendMessage(tab.id, {
      action: 'processCsv',
      csvText: csvText,
      testMode: testMode
    }, (response) => {
      if (chrome.runtime.lastError) {
        showProcessingError('Error: Please refresh the ClaimWizard page and try again');
        return;
      }
      
      if (!response || !response.success) {
        showProcessingError(response?.error || 'Unknown error occurred');
      }
    });

  } catch (error) {
    console.error('Processing error:', error);
    showProcessingError(error.message);
  }
}

function handleExportProgress(message) {
  if (message.action === 'exportProgress') {
    updateProgress(message.current, message.total, message.status);
  } else if (message.action === 'exportComplete') {
    exportedData = message.data;
    chrome.storage.local.set({ 
      exportedData: message.data,
      exportStats: message.stats 
    });
    
    goToStep(4);
    showFinalStats(message.stats);
  } else if (message.action === 'exportError') {
    showProcessingError(message.error);
  }
}

function updateProgress(current, total, status) {
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  const stats = document.getElementById('stats');
  const claimCount = document.getElementById('claimCount');
  
  const percentage = (current / total) * 100;
  fill.style.width = `${percentage}%`;
  text.textContent = `${current} / ${total} claims - ${status}`;
  
  if (current > 0) {
    stats.classList.remove('hidden');
    claimCount.textContent = current;
  }
}

function showFinalStats(stats) {
  document.getElementById('finalClaimCount').textContent = stats.claimCount || 0;
  document.getElementById('finalPersonnelCount').textContent = stats.personnelCount || 0;
}

function showProcessingError(message) {
  const statusEl = document.getElementById('processingStatus');
  statusEl.className = 'status-badge error';
  statusEl.textContent = `✗ Error: ${message}`;
  
  setTimeout(() => {
    goToStep(2);
  }, 3000);
}

function downloadJson() {
  if (!exportedData) {
    alert('No data to download');
    return;
  }

  const dataStr = JSON.stringify(exportedData, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const a = document.createElement('a');
  a.href = url;
  a.download = `claims-export-${timestamp}.json`;
  a.click();
  
  URL.revokeObjectURL(url);
}

function startOver() {
  // Clear data
  chrome.storage.local.remove(['exportedData', 'exportStats', 'exportProgress', 'exportError']);
  exportedData = null;
  uploadedFile = null;
  
  // Reset UI
  const uploadArea = document.getElementById('uploadArea');
  const fileInfo = document.getElementById('fileInfo');
  const startButton = document.getElementById('startProcessing');
  
  uploadArea.classList.remove('has-file');
  fileInfo.classList.add('hidden');
  startButton.disabled = true;
  
  document.getElementById('csvUpload').value = '';
  document.getElementById('progressFill').style.width = '0%';
  
  goToStep(1);
}
