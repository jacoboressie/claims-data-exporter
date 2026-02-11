/**
 * Claims Data Exporter - Content Script
 * Processes CSV export and fetches claim details
 * 
 * KEY DESIGN: Every claim is saved to chrome.storage.local immediately after
 * it's fetched. If the page crashes, all previously fetched claims are safe
 * and the export can be resumed from where it left off.
 */

console.log('🔄 Claims Data Exporter loaded');

/**
 * Send a message to popup/background safely.
 * Won't crash if popup is closed (user switched tabs, etc.)
 */
function safeSendMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // Popup is closed - that's fine, progress is saved to storage
      }
    });
  } catch (e) {
    // Extension context invalidated or similar - ignore
  }
}

/**
 * Persist current export progress to chrome.storage so popup can
 * pick it up even if it was closed and reopened.
 */
function saveProgress(current, total, status) {
  chrome.storage.local.set({
    exportProgress: { current, total, status, timestamp: Date.now() }
  });
}

/**
 * Save a single completed claim to storage immediately.
 * Uses an indexed key pattern: exportedClaim_0, exportedClaim_1, etc.
 * This way each claim is persisted the instant it's done.
 */
async function saveClaimToStorage(index, claimData) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [`exportedClaim_${index}`]: claimData }, resolve);
  });
}


// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'processCsv') {
    // Clear any previous export state
    chrome.storage.local.remove(['exportComplete', 'exportProgress', 'exportError']);

    processCsvAndFetchData(request.csvText, request.testMode)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('Processing failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'resumeExport') {
    // Resume a previously interrupted export
    resumeExport()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('Resume failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true;
  }
});

/**
 * Main processing function
 */
async function processCsvAndFetchData(csvText, testMode = false) {
  try {
    console.log('📄 Parsing CSV...');
    
    const claims = parseCsv(csvText);
    console.log(`Found ${claims.length} claims in CSV`);
    
    if (claims.length === 0) {
      throw new Error('No claims found in CSV');
    }

    const claimsToProcess = testMode ? claims.slice(0, 1) : claims;
    
    // Save the job info so we can resume if interrupted
    await new Promise((resolve) => {
      chrome.storage.local.set({
        exportJob: {
          fileNumbers: claimsToProcess.map(c => c.fileNumber),
          total: claimsToProcess.length,
          completedCount: 0,
          testMode: testMode,
          startedAt: Date.now()
        }
      }, resolve);
    });

    await processClaimsList(claimsToProcess, 0);

  } catch (error) {
    console.error('Export error:', error);
    chrome.storage.local.set({
      exportError: error.message,
      exportProgress: null
    });
    safeSendMessage({
      action: 'exportError',
      error: error.message
    });
  }
}

/**
 * Resume an interrupted export using saved job info
 */
async function resumeExport() {
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(['exportJob'], resolve);
    });
    
    const job = stored.exportJob;
    if (!job) {
      throw new Error('No export job found to resume');
    }
    
    console.log(`📄 Resuming export: ${job.completedCount}/${job.total} already done`);
    
    // Rebuild the claims list from saved file numbers
    const claimsToProcess = job.fileNumbers.map((fn, i) => ({
      fileNumber: fn,
      rowIndex: i
    }));
    
    await processClaimsList(claimsToProcess, job.completedCount);
    
  } catch (error) {
    console.error('Resume error:', error);
    chrome.storage.local.set({
      exportError: error.message,
      exportProgress: null
    });
    safeSendMessage({
      action: 'exportError',
      error: error.message
    });
  }
}

/**
 * Process claims starting from a given index.
 * Each claim is saved to storage immediately after completion.
 */
async function processClaimsList(claimsToProcess, startFrom) {
  const total = claimsToProcess.length;
  
  saveProgress(startFrom, total, startFrom > 0 ? 'Resuming...' : 'Starting...');
  safeSendMessage({
    action: 'exportProgress',
    current: startFrom,
    total: total,
    status: startFrom > 0 ? 'Resuming...' : 'Starting...'
  });

  console.log(`Processing claims ${startFrom + 1} to ${total}...`);

  for (let i = startFrom; i < total; i++) {
    const claim = claimsToProcess[i];
    
    saveProgress(i + 1, total, `Processing ${claim.fileNumber}...`);
    safeSendMessage({
      action: 'exportProgress',
      current: i + 1,
      total: total,
      status: `Processing ${claim.fileNumber}...`
    });

    let claimData;
    try {
      claimData = await fetchClaimDetails(claim);
      console.log(`✓ [${i + 1}/${total}] Processed ${claim.fileNumber}`);
    } catch (error) {
      console.error(`✗ [${i + 1}/${total}] Failed ${claim.fileNumber}:`, error);
      claimData = { ...claim, error: error.message };
    }

    // SAVE THIS CLAIM IMMEDIATELY — crash-proof
    await saveClaimToStorage(i, claimData);
    
    // Update just the completed count (don't rewrite the full fileNumbers array every time)
    chrome.storage.local.get(['exportJob'], (result) => {
      if (result.exportJob) {
        result.exportJob.completedCount = i + 1;
        chrome.storage.local.set({ exportJob: result.exportJob });
      }
    });

    // Randomized delay between claims (1-2.5s) - mimics a human clicking through
    if (i < total - 1) {
      await sleep(1000 + Math.random() * 1500);
    }
  }

  // All done — just mark the job as finished.
  // Don't load/assemble everything here — that could crash on large exports.
  // The popup will assemble the final JSON at download time, streaming from individual claim keys.
  console.log(`✅ Export complete! ${total} claims saved to storage.`);

  saveProgress(total, total, 'Complete!');
  
  chrome.storage.local.set({
    exportProgress: null,
    exportComplete: true
  });

  safeSendMessage({
    action: 'exportComplete',
    stats: { claimCount: total }
  });
}

/**
 * Parse entire CSV text into rows of fields.
 * Handles commas AND newlines inside quoted fields properly.
 * e.g. "Smith, John" stays as one field, and multi-line notes stay in one row.
 */
function parseCsvRows(csvText) {
  const rows = [];
  let currentField = '';
  let currentRow = [];
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < csvText.length && csvText[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\n' || (char === '\r' && csvText[i + 1] === '\n')) {
        if (char === '\r') i++;
        currentRow.push(currentField.trim());
        currentField = '';
        if (currentRow.some(f => f.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }

  currentRow.push(currentField.trim());
  if (currentRow.some(f => f.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Parse CSV file to extract claim data
 */
function parseCsv(csvText) {
  const rows = parseCsvRows(csvText);

  if (rows.length < 2) {
    throw new Error('CSV file is empty or invalid');
  }

  const headers = rows[0];
  const expectedColumns = headers.length;
  
  console.log(`CSV has ${rows.length - 1} data rows and ${expectedColumns} columns`);
  console.log(`Headers: ${headers.join(' | ')}`);

  // Find column index - use specific matching with priority
  const exactNames = ['file number', 'file #', 'file#', 'filenumber', 'claim number', 'claim #', 'claim#', 'claimnumber'];
  let fileNumberIndex = headers.findIndex(h => 
    exactNames.includes(h.toLowerCase().trim())
  );
  
  if (fileNumberIndex === -1) {
    fileNumberIndex = headers.findIndex(h => {
      const lower = h.toLowerCase().trim();
      return (lower.startsWith('file') || lower.startsWith('claim')) && 
             (lower.includes('number') || lower.includes('#') || lower.includes('no'));
    });
  }
  
  if (fileNumberIndex === -1) {
    const excludePatterns = ['profile', 'filed', 'filename', 'claim status', 'claim type', 'claim date'];
    fileNumberIndex = headers.findIndex(h => {
      const lower = h.toLowerCase().trim();
      if (excludePatterns.some(ex => lower.includes(ex))) return false;
      return lower.includes('file') || lower.includes('claim');
    });
  }
  
  if (fileNumberIndex === -1) {
    throw new Error('Could not find claim/file number column in CSV. Headers found: ' + headers.join(', '));
  }

  console.log(`Using column "${headers[fileNumberIndex]}" (index ${fileNumberIndex}) for file numbers`);

  const seen = new Set();
  const claims = [];
  let skippedBadRows = 0;
  
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    
    if (values.length < fileNumberIndex + 1) {
      skippedBadRows++;
      continue;
    }
    
    const fileNumber = values[fileNumberIndex];
    
    if (fileNumber && !seen.has(fileNumber)) {
      seen.add(fileNumber);
      claims.push({
        fileNumber: fileNumber,
        rowIndex: i
      });
    } else if (fileNumber && seen.has(fileNumber)) {
      console.log(`Skipping duplicate file number: ${fileNumber} (row ${i + 1})`);
    }
  }

  if (skippedBadRows > 0) {
    console.log(`Skipped ${skippedBadRows} malformed rows`);
  }

  console.log(`Parsed ${claims.length} unique claims from CSV`);
  return claims;
}

/**
 * Fetch detailed claim data from ClaimWizard API
 * Mimics natural browser traffic: search → load claim page → concurrent data fetches
 */
async function fetchClaimDetails(claim) {
  const fileNumber = claim.fileNumber;

  // Step 1: Search for claim to get ID and UUID
  const formData = new URLSearchParams();
  formData.append('criteria', fileNumber);
  formData.append('type', '');
  
  const searchResults = await fetch('https://app.claimwizard.com/api/search/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01'
    },
    body: formData.toString(),
    credentials: 'include'
  });

  if (!searchResults.ok) {
    throw new Error(`Search failed: ${searchResults.status}`);
  }

  const searchData = await searchResults.json();

  if (!searchData || !searchData.Claims || searchData.Claims.length === 0) {
    throw new Error(`Claim not found: ${fileNumber}`);
  }

  const claimInfo = searchData.Claims[0];
  const claimId = claimInfo.id;
  const claimUuid = claimInfo.uuid;

  const claimResult = {
    fileNumber: fileNumber,
    claimId: claimId,
    claimUuid: claimUuid,
    claimDetails: claimInfo
  };

  // Step 2: Fetch full claim details first (needs UUID)
  const fullDetails = await fetchApi(`/api/claim/${claimUuid}`);
  
  if (fullDetails) {
    claimResult.fullClaimData = fullDetails;
    
    if (fullDetails.propcontacts) {
      const contacts = [];
      
      if (fullDetails.propcontacts.c) {
        const primary = fullDetails.propcontacts.c;
        contacts.push({
          id: primary.id,
          uuid: primary.uuid,
          firstName: primary.firstName || '',
          lastName: primary.lastName || '',
          email: primary.email || '',
          phone: primary.preferredPhone?.number || primary.phone?.number || '',
          address: primary.address,
          isPrimary: true
        });
      }
      
      if (fullDetails.propcontacts.cc && Array.isArray(fullDetails.propcontacts.cc)) {
        fullDetails.propcontacts.cc.forEach(contact => {
          contacts.push({
            id: contact.id,
            uuid: contact.uuid || contact.uniqueID,
            firstName: contact.firstName || contact.name?.firstName || '',
            lastName: contact.lastName || contact.name?.lastName || '',
            email: contact.email || '',
            phone: contact.preferredPhone?.number || '',
            address: contact.physicalAddress,
            isPrimary: false
          });
        });
      }
      
      claimResult.contacts = contacts;
    }

    if (fullDetails.personnel) claimResult.personnel = fullDetails.personnel;
    if (fullDetails.phases) claimResult.phases = fullDetails.phases;
  }

  // Step 3: Fire all remaining data fetches concurrently (natural page load pattern)
  const [
    insuranceResult,
    mortgagesResult,
    externalResult,
    actionsResult,
    ledgerResult,
    filesResult,
    notesResult,
    activityResult
  ] = await Promise.allSettled([
    fetchApi(`/api/claim/${claimId}/insurance`),
    fetchApi(`/api/claim/${claimId}/mortgages/`),
    fetchApi(`/api/claim/${claimId}/personnel/external/1?ip=1`),
    fetchApi(`/api/actions/1/${claimUuid}`),
    fetchApi(`/api/claim/${claimId}/ledger`),
    fetchAllFiles(claimId),
    fetchApi(`/api/claim/${claimId}/notes`),
    fetchApi(`/api/claim/${claimUuid}/activity?sc_u=0&sc_e=0&sc_c=0&sc_pub=0&sc_prv=0&sc_s=0&sc_cus=0&sc_t=0`)
  ]);

  if (insuranceResult.status === 'fulfilled' && insuranceResult.value?.data?.insurance) {
    claimResult.insurance = insuranceResult.value.data.insurance;
  }
  if (mortgagesResult.status === 'fulfilled' && Array.isArray(mortgagesResult.value)) {
    claimResult.mortgages = mortgagesResult.value;
  }
  if (externalResult.status === 'fulfilled' && Array.isArray(externalResult.value)) {
    claimResult.externalPersonnel = externalResult.value;
  }
  if (actionsResult.status === 'fulfilled' && Array.isArray(actionsResult.value)) {
    claimResult.actionItems = actionsResult.value;
  }
  if (ledgerResult.status === 'fulfilled' && ledgerResult.value?.ledger) {
    claimResult.ledger = ledgerResult.value.ledger;
    claimResult.ledgerNotes = ledgerResult.value.notes || [];
    claimResult.ledgerInvoices = ledgerResult.value.invoices || [];
  }
  if (filesResult.status === 'fulfilled' && filesResult.value?.length > 0) {
    claimResult.files = filesResult.value.map(file => ({
      title: file.title,
      filename: file.filename,
      key: file.key,
      folder: false,
      size: file.size,
      fileDate: file.fileDate,
      description: file.description,
      downloadUrl: `https://app.claimwizard.com/api/claim/${claimUuid}/file/${file.key}/?_vw=inline`
    }));
  }
  if (notesResult.status === 'fulfilled' && Array.isArray(notesResult.value)) {
    claimResult.notes = notesResult.value;
  }
  if (activityResult.status === 'fulfilled' && activityResult.value?.data?.activity && Array.isArray(activityResult.value.data.activity)) {
    claimResult.activity = activityResult.value.data.activity;
  }

  return claimResult;
}

/**
 * Fetch files recursively (including folders)
 */
async function fetchAllFiles(claimId, folderKey = null, depth = 0) {
  const maxDepth = 5;
  if (depth > maxDepth) return [];

  const folderPath = folderKey ? `tree/${folderKey}` : 'tree';
  
  try {
    const filesResponse = await fetchApi(`/api/claim/${claimId}/files/${folderPath}?th=n`);
    
    if (!Array.isArray(filesResponse)) return [];

    const allFiles = [];
    for (const item of filesResponse) {
      if (item.folder && item.hasChildren && item.key && item.key !== 'ATTACHMENTS') {
        await sleep(200);
        const folderFiles = await fetchAllFiles(claimId, item.key, depth + 1);
        allFiles.push(...folderFiles);
      } else if (!item.folder && item.filename) {
        allFiles.push(item);
      }
    }
    
    return allFiles;
  } catch (error) {
    console.error(`Error fetching files:`, error);
    return [];
  }
}

/**
 * Make an API call to ClaimWizard
 */
async function fetchApi(endpoint) {
  const baseUrl = 'https://app.claimwizard.com';
  const url = `${baseUrl}${endpoint}${endpoint.includes('?') ? '&' : '?'}_=${Date.now()}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest'
    },
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`API call failed: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Count unique personnel across all claims
 */
function countUniquePersonnel(claims) {
  const emails = new Set();
  
  claims.forEach(claim => {
    const personnel = claim.fullClaimData?.personnel || claim.personnel || [];
    personnel.forEach(person => {
      const email = person.email || person.person?.email;
      if (email) emails.add(email);
    });
  });

  return emails.size;
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
