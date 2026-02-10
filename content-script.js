/**
 * Claims Data Exporter - Content Script
 * Processes CSV export and fetches claim details
 */

console.log('🔄 Claims Data Exporter loaded');

/**
 * Send a message to popup/background safely.
 * Won't crash if popup is closed (user switched tabs, etc.)
 */
function safeSendMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      // Check for error (popup closed) and suppress it
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

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'processCsv') {
    // Clear any previous export state
    chrome.storage.local.remove(['exportedData', 'exportStats', 'exportProgress', 'exportError']);

    processCsvAndFetchData(request.csvText, request.testMode)
      .then(() => {
        sendResponse({ success: true, claimCount: 0 });
      })
      .catch((error) => {
        console.error('Processing failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep channel open for async response
  }
});

/**
 * Main processing function
 */
async function processCsvAndFetchData(csvText, testMode = false) {
  try {
    console.log('📄 Parsing CSV...');
    
    // Parse CSV to extract claim IDs
    const claims = parseCsv(csvText);
    console.log(`Found ${claims.length} claims in CSV`);
    
    if (claims.length === 0) {
      throw new Error('No claims found in CSV');
    }

    // Limit claims in test mode
    const claimsToProcess = testMode ? claims.slice(0, 1) : claims;
    
    // Notify popup of claim count & save to storage
    saveProgress(0, claimsToProcess.length, 'Starting...');
    safeSendMessage({
      action: 'exportProgress',
      current: 0,
      total: claimsToProcess.length,
      status: 'Starting...'
    });

    console.log(`Processing ${claimsToProcess.length} claims...`);

    // Fetch detailed data for each claim
    const claimsWithData = [];
    
    for (let i = 0; i < claimsToProcess.length; i++) {
      const claim = claimsToProcess[i];
      
      saveProgress(i + 1, claimsToProcess.length, `Processing ${claim.fileNumber}...`);
      safeSendMessage({
        action: 'exportProgress',
        current: i + 1,
        total: claimsToProcess.length,
        status: `Processing ${claim.fileNumber}...`
      });

      try {
        const claimData = await fetchClaimDetails(claim);
        claimsWithData.push(claimData);
        console.log(`✓ Processed ${claim.fileNumber}`);
      } catch (error) {
        console.error(`✗ Failed to process ${claim.fileNumber}:`, error);
        // Add with error so we don't lose the claim
        claimsWithData.push({
          ...claim,
          error: error.message
        });
      }

      // Randomized delay between claims (1-2.5s) - mimics a human clicking through
      // Fixed intervals look bot-like; random ones look like a person browsing
      await sleep(1000 + Math.random() * 1500);
    }

    // Build the final export data structure
    // Note: Keeps "claimWizardData" for backwards compatibility with import service
    const exportData = {
      claimWizardData: {
        claims: claimsWithData,
        exportDate: new Date().toISOString(),
        exportMethod: 'chrome-extension'
      },
      exportInfo: {
        date: new Date().toISOString(),
        version: '1.0.1',
        source: 'chrome-extension',
        totalClaims: claimsWithData.length
      }
    };

    // Calculate stats
    const stats = {
      claimCount: claimsWithData.length,
      personnelCount: countUniquePersonnel(claimsWithData)
    };

    // Save to storage FIRST (in case popup is closed)
    chrome.storage.local.set({
      exportedData: exportData,
      exportStats: stats,
      exportProgress: null // Clear progress - we're done
    });

    // Then notify popup if it's open
    safeSendMessage({
      action: 'exportComplete',
      data: exportData,
      stats: stats
    });

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
        // Check for escaped quote ("")
        if (i + 1 < csvText.length && csvText[i + 1] === '"') {
          currentField += '"';
          i++; // Skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        // Inside quotes: keep everything including commas and newlines
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\n' || (char === '\r' && csvText[i + 1] === '\n')) {
        // End of row
        if (char === '\r') i++; // Skip \n in \r\n
        currentRow.push(currentField.trim());
        currentField = '';
        // Only add non-empty rows
        if (currentRow.some(f => f.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }

  // Don't forget the last field/row
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
  // Parse entire CSV respecting quoted fields (handles commas + newlines in quotes)
  const rows = parseCsvRows(csvText);

  if (rows.length < 2) {
    throw new Error('CSV file is empty or invalid');
  }

  // First row is headers
  const headers = rows[0];
  const expectedColumns = headers.length;
  
  console.log(`CSV has ${rows.length - 1} data rows and ${expectedColumns} columns`);
  console.log(`Headers: ${headers.join(' | ')}`);

  // Find column index - use specific matching with priority
  // Priority 1: exact common names
  const exactNames = ['file number', 'file #', 'file#', 'filenumber', 'claim number', 'claim #', 'claim#', 'claimnumber'];
  let fileNumberIndex = headers.findIndex(h => 
    exactNames.includes(h.toLowerCase().trim())
  );
  
  // Priority 2: starts with "file" or "claim" and contains "number" or "#"
  if (fileNumberIndex === -1) {
    fileNumberIndex = headers.findIndex(h => {
      const lower = h.toLowerCase().trim();
      return (lower.startsWith('file') || lower.startsWith('claim')) && 
             (lower.includes('number') || lower.includes('#') || lower.includes('no'));
    });
  }
  
  // Priority 3: fallback to broader match but exclude common false positives
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

  // Parse data rows with deduplication
  const seen = new Set();
  const claims = [];
  let skippedBadRows = 0;
  
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    
    // Skip rows that don't have enough columns (malformed)
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
 * (just like a real user clicking into a claim, which fires all XHRs at once)
 */
async function fetchClaimDetails(claim) {
  const fileNumber = claim.fileNumber;
  console.log(`Fetching details for claim: ${fileNumber}`);

  // Step 1: Search for claim to get ID and UUID (sequential - user types and searches)
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

  console.log(`  Found: ID=${claimId}, UUID=${claimUuid}`);

  // Build claim result object
  const claimResult = {
    fileNumber: fileNumber,
    claimId: claimId,
    claimUuid: claimUuid,
    claimDetails: claimInfo
  };

  // Step 2: Fetch full claim details first (needs to complete before we process contacts)
  console.log(`  Loading claim page data...`);
  const fullDetails = await fetchApi(`/api/claim/${claimUuid}`);
  
  if (fullDetails) {
    claimResult.fullClaimData = fullDetails;
    
    // Extract contacts
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

  // Step 3: Fire all remaining data fetches concurrently
  // This mimics what happens when a real user opens a claim page —
  // the browser fires all the tab/panel XHRs at the same time.
  console.log(`  Fetching all claim sections...`);

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

  // Process results - each one is { status: 'fulfilled', value } or { status: 'rejected', reason }
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

  console.log(`  ✓ Complete!`);
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
        // Recursively fetch folder contents
        await sleep(200); // Small delay for nested folder requests
        const folderFiles = await fetchAllFiles(claimId, item.key, depth + 1);
        allFiles.push(...folderFiles);
      } else if (!item.folder && item.filename) {
        // It's a file
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
 * Uses the browser's existing session (cookies)
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
    credentials: 'include' // Include cookies (user's session)
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
