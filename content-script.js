/**
 * Claims Data Exporter - Content Script
 * Processes CSV export and fetches claim details
 */

console.log('🔄 Claims Data Exporter loaded');

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'processCsv') {
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
    
    // Notify popup of claim count
    chrome.runtime.sendMessage({
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
      
      chrome.runtime.sendMessage({
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

      // Rate limiting - wait 500ms between claims (after all endpoints fetched)
      await sleep(500);
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
      version: '1.0.0',
      source: 'chrome-extension',
      totalClaims: claimsWithData.length
    }
  };

    // Calculate stats
    const stats = {
      claimCount: claimsWithData.length,
      personnelCount: countUniquePersonnel(claimsWithData)
    };

    // Send completion message
    chrome.runtime.sendMessage({
      action: 'exportComplete',
      data: exportData,
      stats: stats
    });

  } catch (error) {
    console.error('Export error:', error);
    chrome.runtime.sendMessage({
      action: 'exportError',
      error: error.message
    });
  }
}

/**
 * Parse CSV file to extract claim data
 */
function parseCsv(csvText) {
  const lines = csvText.split('\n').filter(line => line.trim());
  
  if (lines.length < 2) {
    throw new Error('CSV file is empty or invalid');
  }

  // Parse header row
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  
  // Find column indices
  const fileNumberIndex = headers.findIndex(h => 
    h.toLowerCase().includes('file') || h.toLowerCase().includes('claim')
  );
  
  if (fileNumberIndex === -1) {
    throw new Error('Could not find claim/file number column in CSV');
  }

  // Parse data rows
  const claims = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
    const fileNumber = values[fileNumberIndex];
    
    if (fileNumber) {
      claims.push({
        fileNumber: fileNumber,
        rowIndex: i
      });
    }
  }

  return claims;
}

/**
 * Fetch detailed claim data from ClaimWizard API
 * This replicates what the Puppeteer collection service does
 */
async function fetchClaimDetails(claim) {
  const fileNumber = claim.fileNumber;
  console.log(`Fetching details for claim: ${fileNumber}`);

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

  console.log(`  Found: ID=${claimId}, UUID=${claimUuid}`);

  // Build claim result object
  const claimResult = {
    fileNumber: fileNumber,
    claimId: claimId,
    claimUuid: claimUuid,
    claimDetails: claimInfo
  };

  // Step 2: Fetch full claim details (uses UUID not ID!)
  console.log(`  Fetching main details...`);
  const fullDetails = await fetchApi(`/api/claim/${claimUuid}`);
  await sleep(300); // Wait 300ms before next API call
  
  if (fullDetails) {
    claimResult.fullClaimData = fullDetails;
    
    // Extract contacts
    if (fullDetails.propcontacts) {
      const contacts = [];
      
      // Primary contact
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
      
      // Additional contacts
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

    // Extract personnel, phases from fullClaimData
    if (fullDetails.personnel) claimResult.personnel = fullDetails.personnel;
    if (fullDetails.phases) claimResult.phases = fullDetails.phases;
  }

  // Step 3: Fetch insurance
  console.log(`  Fetching insurance...`);
  try {
    const insurance = await fetchApi(`/api/claim/${claimId}/insurance`);
    await sleep(300); // Wait between calls
    if (insurance?.data?.insurance) {
      claimResult.insurance = insurance.data.insurance;
    }
  } catch (e) {
    console.log(`  No insurance data`);
  }

  // Step 4: Fetch mortgages
  console.log(`  Fetching mortgages...`);
  try {
    const mortgages = await fetchApi(`/api/claim/${claimId}/mortgages/`);
    await sleep(300); // Wait between calls
    if (Array.isArray(mortgages)) {
      claimResult.mortgages = mortgages;
    }
  } catch (e) {
    console.log(`  No mortgage data`);
  }

  // Step 5: Fetch external personnel
  console.log(`  Fetching external personnel...`);
  try {
    const external = await fetchApi(`/api/claim/${claimId}/personnel/external/1?ip=1`);
    await sleep(300); // Wait between calls
    if (Array.isArray(external)) {
      claimResult.externalPersonnel = external;
    }
  } catch (e) {
    console.log(`  No external personnel`);
  }

  // Step 6: Fetch action items (uses UUID)
  console.log(`  Fetching action items...`);
  try {
    const actions = await fetchApi(`/api/actions/1/${claimUuid}`);
    await sleep(300); // Wait between calls
    if (Array.isArray(actions)) {
      claimResult.actionItems = actions;
    }
  } catch (e) {
    console.log(`  No action items`);
  }

  // Step 7: Fetch ledger
  console.log(`  Fetching ledger...`);
  try {
    const ledger = await fetchApi(`/api/claim/${claimId}/ledger`);
    await sleep(300); // Wait between calls
    if (ledger && ledger.ledger) {
      claimResult.ledger = ledger.ledger;
      claimResult.ledgerNotes = ledger.notes || [];
      claimResult.ledgerInvoices = ledger.invoices || [];
    }
  } catch (e) {
    console.log(`  No ledger data`);
  }

  // Step 8: Fetch files
  console.log(`  Fetching files...`);
  try {
    const files = await fetchAllFiles(claimId);
    await sleep(300); // Wait between calls
    if (files && files.length > 0) {
      claimResult.files = files.map(file => ({
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
  } catch (e) {
    console.log(`  No files`);
  }

  // Step 9: Fetch notes
  console.log(`  Fetching notes...`);
  try {
    const notes = await fetchApi(`/api/claim/${claimId}/notes`);
    await sleep(300); // Wait between calls
    if (Array.isArray(notes)) {
      claimResult.notes = notes;
    }
  } catch (e) {
    console.log(`  No notes`);
  }

  // Step 10: Fetch activity (uses UUID)
  console.log(`  Fetching activity...`);
  try {
    const activity = await fetchApi(
      `/api/claim/${claimUuid}/activity?sc_u=0&sc_e=0&sc_c=0&sc_pub=0&sc_prv=0&sc_s=0&sc_cus=0&sc_t=0`
    );
    await sleep(300); // Wait between calls
    if (activity?.data?.activity && Array.isArray(activity.data.activity)) {
      claimResult.activity = activity.data.activity;
    }
  } catch (e) {
    console.log(`  No activity`);
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
        await sleep(400); // Slower for nested folder requests
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
