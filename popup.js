// Popup UI Controller with Step Wizard
let uploadedFile = null;
let currentStep = 1;

// How long before we consider progress "stale" (page probably crashed)
const STALE_THRESHOLD_MS = 30000; // 30 seconds

// How many claims to load from storage at once during download
const LOAD_BATCH_SIZE = 100;

document.addEventListener('DOMContentLoaded', async () => {
  // Load saved settings
  const settings = await chrome.storage.local.get(['testMode']);
  if (settings.testMode) document.getElementById('testMode').checked = true;

  // Check current state: completed, in-progress, crashed, or error
  const stored = await chrome.storage.local.get([
    'exportComplete', 'exportProgress', 'exportError', 'exportJob'
  ]);
  
  if (stored.exportComplete && stored.exportJob) {
    // Export finished — show download step
    goToStep(4);
    showFinalStats({ claimCount: stored.exportJob.completedCount || stored.exportJob.total });
  } else if (stored.exportProgress && stored.exportProgress.current != null) {
    const timeSinceUpdate = Date.now() - (stored.exportProgress.timestamp || 0);
    
    if (timeSinceUpdate > STALE_THRESHOLD_MS && stored.exportJob) {
      // Progress is stale — page probably crashed
      goToStep(3);
      updateProgress(
        stored.exportProgress.current,
        stored.exportProgress.total,
        stored.exportProgress.status
      );
      showCrashRecovery(stored.exportJob);
    } else {
      // Export is actively running
      goToStep(3);
      updateProgress(
        stored.exportProgress.current,
        stored.exportProgress.total,
        stored.exportProgress.status
      );
    }
  } else if (stored.exportJob && stored.exportJob.completedCount > 0 && !stored.exportComplete) {
    // Have a job with saved claims but not complete — crashed
    goToStep(3);
    updateProgress(
      stored.exportJob.completedCount,
      stored.exportJob.total,
      'Interrupted'
    );
    showCrashRecovery(stored.exportJob);
  } else if (stored.exportError) {
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

  // Crash recovery buttons
  document.getElementById('resumeExport').addEventListener('click', resumeExport);
  document.getElementById('downloadPartial').addEventListener('click', () => downloadFromStorage(true));
  document.getElementById('crashStartOver').addEventListener('click', startOver);

  // Listen for progress updates via messages (when popup stays open)
  chrome.runtime.onMessage.addListener(handleExportProgress);

  // Listen for storage changes (picks up progress when popup is reopened mid-export)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    
    if (changes.exportProgress && changes.exportProgress.newValue) {
      const p = changes.exportProgress.newValue;
      if (currentStep === 3 && p.current != null) {
        hideCrashRecovery();
        updateProgress(p.current, p.total, p.status);
      }
    }
    
    if (changes.exportComplete && changes.exportComplete.newValue === true) {
      chrome.storage.local.get(['exportJob'], (result) => {
        const job = result.exportJob;
        if (job) {
          goToStep(4);
          showFinalStats({ claimCount: job.completedCount || job.total });
        }
      });
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
  
  document.querySelectorAll('.step').forEach(el => {
    const stepNum = parseInt(el.dataset.step);
    const stepNumber = el.querySelector('.step-number');
    
    el.classList.remove('active', 'completed');
    
    if (stepNum < step) {
      el.classList.add('completed');
      stepNumber.textContent = '✓';
    } else if (stepNum === step) {
      el.classList.add('active');
      stepNumber.textContent = stepNum;
    } else {
      stepNumber.textContent = stepNum;
    }
  });
  
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

  goToStep(3);
  hideCrashRecovery();

  try {
    const csvText = await uploadedFile.text();
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes('claimwizard.com')) {
      showProcessingError('Please open ClaimWizard in this tab first!');
      return;
    }

    const testMode = document.getElementById('testMode').checked;

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

/**
 * Resume an interrupted export
 */
async function resumeExport() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url || !tab.url.includes('claimwizard.com')) {
      showProcessingError('Please open ClaimWizard in this tab first, then resume.');
      return;
    }

    hideCrashRecovery();
    document.getElementById('processingTitle').textContent = 'Resuming Export...';
    document.getElementById('processingDesc').textContent = 'Picking up where we left off.';
    document.getElementById('processingStatus').className = 'status-badge info';
    document.getElementById('processingStatus').textContent = 'Resuming...';

    chrome.tabs.sendMessage(tab.id, { action: 'resumeExport' }, (response) => {
      if (chrome.runtime.lastError) {
        showProcessingError('Error: Please refresh the ClaimWizard page and try again');
        return;
      }
      
      if (!response || !response.success) {
        showProcessingError(response?.error || 'Failed to resume');
      }
    });

  } catch (error) {
    console.error('Resume error:', error);
    showProcessingError(error.message);
  }
}

/**
 * Load claims from storage in batches and build the download file.
 * 
 * Memory-safe approach: each batch of claims is stringified, turned into a
 * small Blob, then the strings are released for garbage collection. The final
 * Blob is assembled from sub-Blobs, which the browser handles by reference
 * (no copying). Peak JS heap usage: ~1 batch worth of strings (~5-10MB).
 * 
 * @param {boolean} isPartial - true if this is a partial/interrupted export
 */
async function downloadFromStorage(isPartial = false) {
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get(['exportJob'], resolve));
    const job = stored.exportJob;

    if (!job || job.completedCount === 0) {
      alert('No saved claims found.');
      return;
    }

    const count = job.completedCount;
    const total = job.total;

    // Array of Blobs — each batch becomes one small Blob, then the source strings
    // can be garbage collected. The final Blob references these without copying.
    const blobParts = [];

    // Opening JSON structure
    blobParts.push(new Blob(['{\n  "claimWizardData": {\n    "claims": [\n'], { type: 'text/plain' }));

    let isFirstClaim = true;

    for (let batchStart = 0; batchStart < count; batchStart += LOAD_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + LOAD_BATCH_SIZE, count);
      const keys = [];
      for (let i = batchStart; i < batchEnd; i++) {
        keys.push(`exportedClaim_${i}`);
      }

      // Load this batch from storage
      const batchData = await new Promise(resolve => chrome.storage.local.get(keys, resolve));

      // Stringify this batch's claims into a temporary string
      let batchStr = '';
      for (let i = batchStart; i < batchEnd; i++) {
        const claim = batchData[`exportedClaim_${i}`];
        if (claim) {
          if (!isFirstClaim) batchStr += ',\n';
          batchStr += '      ' + JSON.stringify(claim);
          isFirstClaim = false;
        }
      }

      // Convert this batch to a Blob and push it — the batchStr string
      // will be eligible for GC after this iteration
      if (batchStr.length > 0) {
        blobParts.push(new Blob([batchStr], { type: 'text/plain' }));
      }

      // Let the browser breathe between batches
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    // Closing JSON structure + metadata
    const now = new Date().toISOString();
    let footer = '\n    ],\n';
    footer += `    "exportDate": "${now}",\n`;
    footer += `    "exportMethod": "chrome-extension"\n`;
    footer += '  },\n';
    footer += '  "exportInfo": {\n';
    footer += `    "date": "${now}",\n`;
    footer += `    "version": "1.0.2",\n`;
    footer += `    "source": "chrome-extension",\n`;
    footer += `    "totalClaims": ${count}`;

    if (isPartial) {
      footer += `,\n    "partial": true`;
      footer += `,\n    "originalTotal": ${total}`;
      footer += `,\n    "note": "Partial export: ${count} of ${total} claims (interrupted)"`;
    }

    footer += '\n  }\n}';
    blobParts.push(new Blob([footer], { type: 'text/plain' }));

    // Final Blob — assembled from sub-Blobs by reference, no giant copy
    const blob = new Blob(blobParts, { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const filename = isPartial 
      ? `claims-export-partial-${count}of${total}-${timestamp}.json`
      : `claims-export-${timestamp}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Download error:', error);
    alert('Error building download: ' + error.message);
  }
}

/**
 * Show crash recovery UI
 */
function showCrashRecovery(job) {
  document.getElementById('crashRecovery').classList.remove('hidden');
  document.getElementById('processingStatus').classList.add('hidden');
  document.getElementById('processingTitle').textContent = 'Export Interrupted';
  document.getElementById('processingDesc').textContent = 
    `${job.completedCount} of ${job.total} claims were saved before the interruption.`;
}

function hideCrashRecovery() {
  document.getElementById('crashRecovery').classList.add('hidden');
  document.getElementById('processingStatus').classList.remove('hidden');
  document.getElementById('processingStatus').className = 'status-badge info';
  document.getElementById('processingStatus').textContent = 'Processing...';
  document.getElementById('processingTitle').textContent = 'Processing Claims...';
  document.getElementById('processingDesc').textContent = 'Fetching detailed data for each claim.';
}

function handleExportProgress(message) {
  if (message.action === 'exportProgress') {
    updateProgress(message.current, message.total, message.status);
  } else if (message.action === 'exportComplete') {
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

/**
 * Download the final completed export JSON.
 * Assembles from individual claim keys at download time — never holds
 * the entire dataset in storage as one blob.
 */
function downloadJson() {
  downloadFromStorage(false);
}

function startOver() {
  // Clean up all incremental claims + job data
  chrome.storage.local.get(['exportJob'], (result) => {
    const keysToRemove = ['exportComplete', 'exportProgress', 'exportError', 'exportJob'];
    
    if (result.exportJob) {
      for (let i = 0; i < result.exportJob.total; i++) {
        keysToRemove.push(`exportedClaim_${i}`);
      }
    }
    
    chrome.storage.local.remove(keysToRemove);
  });
  
  uploadedFile = null;
  
  const uploadArea = document.getElementById('uploadArea');
  const fileInfo = document.getElementById('fileInfo');
  const startButton = document.getElementById('startProcessing');
  
  uploadArea.classList.remove('has-file');
  fileInfo.classList.add('hidden');
  startButton.disabled = true;
  
  document.getElementById('csvUpload').value = '';
  document.getElementById('progressFill').style.width = '0%';
  hideCrashRecovery();
  
  goToStep(1);
}
