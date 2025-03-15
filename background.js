var mru = [];
var slowSwitchOngoing = false;
var fastSwitchOngoing = false;
var intSwitchCount = 0;
var lastIntSwitchIndex = 0;
var altPressed = false;
var wPressed = false;

var slowtimerValue = 1500;
var fasttimerValue = 200;
var timer;
var periodicSaveTimer = null;
var PERIODIC_SAVE_INTERVAL = 30000; // Save state every 30 seconds

var slowswitchForward = false;

var initialized = false;
var options = {};
var currentWindowId;
var stateHasBeenPersisted = false;
var lastSavedMRU = [];

var loggingOn = true;

// Functions to persist and restore MRU data
var saveMRUToStorage = function() {
    // Only save if the MRU has changed
    if (JSON.stringify(mru) !== JSON.stringify(lastSavedMRU)) {
        chrome.storage.local.set({ 'mruList': mru }, function() {
            if (chrome.runtime.lastError) {
                CLUTlog("Error saving MRU list: " + chrome.runtime.lastError.message);
            } else {
                CLUTlog("MRU list saved to storage, length: " + mru.length);
                lastSavedMRU = [...mru]; // Create a copy of the current MRU
            }
        });
    } else {
        CLUTlog("MRU unchanged, skipping save");
    }
};

// Start periodic saving
var startPeriodicSave = function() {
    if (periodicSaveTimer) {
        clearInterval(periodicSaveTimer);
    }
    
    periodicSaveTimer = setInterval(function() {
        CLUTlog("Performing periodic MRU save");
        saveMRUToStorage();
    }, PERIODIC_SAVE_INTERVAL);
    
    CLUTlog("Started periodic MRU saving every " + (PERIODIC_SAVE_INTERVAL/1000) + " seconds");
};

// Stop periodic saving
var stopPeriodicSave = function() {
    if (periodicSaveTimer) {
        clearInterval(periodicSaveTimer);
        periodicSaveTimer = null;
        CLUTlog("Stopped periodic MRU saving");
    }
};

var restoreMRUFromStorage = function() {
    chrome.storage.local.get(['mruList'], function(result) {
        if (result.mruList && Array.isArray(result.mruList) && result.mruList.length > 0) {
            mru = result.mruList;
            CLUTlog("MRU list restored from storage, length: " + mru.length);
            // Validate the tabs in the restored MRU to ensure they still exist
            validateMRUTabs();
        } else {
            CLUTlog("No valid MRU list found in storage, initializing fresh");
            // If no MRU list in storage, initialize from scratch
            refreshMRUFromCurrentTabs();
        }
    });
};

var validateMRUTabs = function(callback) {
    // First check if we have any tabs to validate
    if (!mru || mru.length === 0) {
        CLUTlog("Empty MRU list, refreshing from current tabs");
        refreshMRUFromCurrentTabs();
        if (callback) callback();
        return;
    }

    // Use a faster validation method when called during activation
    if (callback) {
        // Just check the first tab for quick validation
        chrome.tabs.get(mru[0], tab => {
            if (chrome.runtime.lastError) {
                CLUTlog("First tab in MRU is invalid, doing full validation");
                // If first tab is invalid, do a full validation
                performFullValidation(callback);
            } else {
                CLUTlog("Quick validation passed");
                if (callback) callback();
            }
        });
        return;
    }

    // Otherwise do the full validation
    performFullValidation(callback);
};

var performFullValidation = function(callback) {
    // Filter out tab IDs that no longer exist
    const tabPromises = mru.map(tabId => 
        new Promise(resolve => {
            chrome.tabs.get(tabId, tab => {
                if (chrome.runtime.lastError) {
                    CLUTlog(`Tab ${tabId} no longer exists, will be removed from MRU`);
                    resolve(null); // Tab doesn't exist anymore
                } else {
                    resolve(tabId); // Tab still exists
                }
            });
        })
    );
    
    Promise.all(tabPromises).then(validTabIds => {
        // Filter out null values (tabs that no longer exist)
        const newMRU = validTabIds.filter(tabId => tabId !== null);
        
        if (newMRU.length === 0) {
            CLUTlog("All tabs in MRU are invalid, refreshing from current tabs");
            refreshMRUFromCurrentTabs();
        } else if (newMRU.length !== mru.length) {
            CLUTlog(`Removed ${mru.length - newMRU.length} invalid tabs from MRU, ${newMRU.length} remain`);
            mru = newMRU;
            saveMRUToStorage();
        } else {
            CLUTlog("All tabs in MRU are valid");
        }
        
        if (callback) callback();
    }).catch(error => {
        CLUTlog("Error validating MRU tabs:", error);
        // As a failsafe, refresh from current tabs on error
        refreshMRUFromCurrentTabs();
        if (callback) callback();
    });
};

var refreshMRUFromCurrentTabs = function() {
    mru = [];
    chrome.windows.getAll({ populate: true }, function(windows) {
        windows.forEach(function(window) {
            window.tabs.forEach(function(tab) {
                mru.unshift(tab.id);
            });
        });
        CLUTlog("MRU refreshed from current tabs: " + mru.length + " tabs");
        saveMRUToStorage();
        printMRUSimple();
    });
};

// Listen for service worker lifecycle events
chrome.runtime.onStartup.addListener(function() {
    CLUTlog("Extension startup");
    initialize();
});

// Also handles extension installation and updates
chrome.runtime.onInstalled.addListener(function() {
    CLUTlog("Extension installed/updated");
    initialize();
});

// Listen for when the service worker is about to be terminated
self.addEventListener('freeze', () => {
    CLUTlog("Service worker freezing - saving state");
    stateHasBeenPersisted = true;
    stopPeriodicSave(); // Stop periodic saving as we're about to be suspended
    saveMRUToStorage();
});

// Listen for when the service worker resumes after being inactive
self.addEventListener('resume', () => {
    CLUTlog("Service worker resuming - restoring state");
    // Reset switch states to ensure we're in a clean state
    slowSwitchOngoing = false;
    fastSwitchOngoing = false;
    intSwitchCount = 0;
    isExtensionReady = false; // Mark as not ready during resume
    
    if (stateHasBeenPersisted) {
        // First restore the MRU list
        chrome.storage.local.get(['mruList'], function(result) {
            if (result.mruList && Array.isArray(result.mruList) && result.mruList.length > 0) {
                mru = result.mruList;
                CLUTlog("MRU list restored from storage, length: " + mru.length);
                
                // Then validate tabs with a callback to mark as ready when done
                validateMRUTabs(function() {
                    isExtensionReady = true;
                    CLUTlog("Extension is fully activated and ready for commands after resume");
                });
            } else {
                // If no valid MRU list, refresh and mark as ready
                refreshMRUFromCurrentTabs();
                setTimeout(function() {
                    isExtensionReady = true;
                    CLUTlog("Extension is ready for commands after refresh");
                }, 200);
            }
        });
    } else {
        // If no persisted state, just mark as ready
        isExtensionReady = true;
    }
    
    startPeriodicSave(); // Restart periodic saving
});

// For Manifest V3, also check at the first wake-up if we need to restore
if (typeof chrome.runtime.onSuspend !== 'undefined') {
    // This is a V3 service worker that might have been suspended
    chrome.runtime.onSuspend.addListener(() => {
        CLUTlog("Service worker suspending - saving state");
        stopPeriodicSave();
        saveMRUToStorage();
        stateHasBeenPersisted = true;
    });
}

var CLUTlog = function (...args) {
    if (loggingOn) {
        console.log(...args);
    }
};

// Add a readiness flag and checker
var isExtensionReady = false;

// Function to ensure extension is ready before processing commands
var ensureExtensionReady = function(callback) {
    if (isExtensionReady) {
        callback();
        return;
    }
    
    CLUTlog("Extension not ready yet - preparing for command");
    
    // If not ready, try faster preparation
    if (mru.length === 0) {
        CLUTlog("Empty MRU list, loading from storage");
        // Quick restore from storage
        chrome.storage.local.get(['mruList'], function(result) {
            if (result.mruList && Array.isArray(result.mruList) && result.mruList.length > 0) {
                mru = result.mruList;
                CLUTlog("Loaded " + mru.length + " tabs for immediate command processing");
                isExtensionReady = true;
                callback();
            } else {
                // No stored MRU list, build one immediately
                chrome.windows.getAll({ populate: true }, function(windows) {
                    mru = [];
                    windows.forEach(function(window) {
                        window.tabs.forEach(function(tab) {
                            mru.unshift(tab.id);
                        });
                    });
                    CLUTlog("Built new MRU list with " + mru.length + " tabs for immediate command");
                    isExtensionReady = true;
                    callback();
                });
            }
        });
    } else {
        // We have an MRU list but aren't ready yet - just mark as ready and proceed
        CLUTlog("MRU list already exists, proceeding with command");
        isExtensionReady = true;
        callback();
    }
};

var processCommand = function (command) {
    CLUTlog("Command recd:" + command);
    
    // Ensure extension is ready before processing the command
    ensureExtensionReady(function() {
        var fastswitch = true;
        slowswitchForward = false;
        if (command == "alt_switch_fast") {
            fastswitch = true;
        } else if (command == "alt_switch_slow_backward") {
            fastswitch = false;
            slowswitchForward = false;
        } else if (command == "alt_switch_slow_forward") {
            fastswitch = false;
            slowswitchForward = true;
        }

        if (!slowSwitchOngoing && !fastSwitchOngoing) {
            if (fastswitch) {
                fastSwitchOngoing = true;
            } else {
                slowSwitchOngoing = true;
            }
            CLUTlog("CLUT::START_SWITCH");
            intSwitchCount = 0;
            doIntSwitch();
        } else if ((slowSwitchOngoing && !fastswitch) || (fastSwitchOngoing && fastswitch)) {
            CLUTlog("CLUT::DO_INT_SWITCH");
            doIntSwitch();
        } else if (slowSwitchOngoing && fastswitch) {
            endSwitch();
            fastSwitchOngoing = true;
            CLUTlog("CLUT::START_SWITCH");
            intSwitchCount = 0;
            doIntSwitch();
        } else if (fastSwitchOngoing && !fastswitch) {
            endSwitch();
            slowSwitchOngoing = true;
            CLUTlog("CLUT::START_SWITCH");
            intSwitchCount = 0;
            doIntSwitch();
        }

        if (timer) {
            if (fastSwitchOngoing || slowSwitchOngoing) {
                clearTimeout(timer);
            }
        }
        if (fastswitch) {
            timer = setTimeout(function () {
                endSwitch();
            }, fasttimerValue);
        } else {
            timer = setTimeout(function () {
                endSwitch();
            }, slowtimerValue);
        }
    });
};

chrome.commands.onCommand.addListener(processCommand);

chrome.action.onClicked.addListener(function (tab) {
    CLUTlog("Click recd");
    processCommand("alt_switch_fast");
});

var doIntSwitch = function (recurseLevel = 0) {
    CLUTlog("CLUT:: in int switch, intSwitchCount: " + intSwitchCount + ", mru.length: " + mru.length);
    if (!(0 <= intSwitchCount && intSwitchCount < mru.length)) return;

    if (recurseLevel == 0) {
        return chrome.windows.getCurrent(function (currentWindow) {
            currentWindowId = currentWindow.id;
            doIntSwitch(1);
        });
    }
    if (recurseLevel > mru.length) return; // just in case

    var tabIdToMakeActive;
    //check if tab is still present
    //sometimes tabs have gone missing
    var invalidTab = true;
    var thisWindowId;
    if (slowswitchForward) {
        decrementSwitchCounter();
    } else {
        incrementSwitchCounter();
    }
    tabIdToMakeActive = mru[intSwitchCount];

    chrome.tabs.get(tabIdToMakeActive, function (tab) {
        if (tab) {
            thisWindowId = tab.windowId;

            if (options.onlySameWindow && thisWindowId !== currentWindowId) {
                return doIntSwitch(recurseLevel + 1); // skip this tab
            }

            invalidTab = false;

            chrome.windows.update(thisWindowId, { focused: true });
            chrome.tabs.update(tabIdToMakeActive, { active: true, highlighted: true });
            lastIntSwitchIndex = intSwitchCount;
            //break;
        } else {
            CLUTlog(
                "CLUT:: in int switch, >>invalid tab found.intSwitchCount: " +
                    intSwitchCount +
                    ", mru.length: " +
                    mru.length
            );
            removeItemAtIndexFromMRU(intSwitchCount);
            if (intSwitchCount >= mru.length) {
                intSwitchCount = 0;
            }
            doIntSwitch(recurseLevel + 1);
        }
    });
};

var endSwitch = function () {
    CLUTlog("CLUT::END_SWITCH");
    slowSwitchOngoing = false;
    fastSwitchOngoing = false;
    var tabId = mru[lastIntSwitchIndex];
    putExistingTabToTop(tabId);
    printMRUSimple();
};

chrome.tabs.onActivated.addListener(function (activeInfo) {
    if (!slowSwitchOngoing && !fastSwitchOngoing) {
        var index = mru.indexOf(activeInfo.tabId);

        //probably should not happen since tab created gets called first than activated for new tabs,
        // but added as a backup behavior to avoid orphan tabs
        if (index == -1) {
            CLUTlog("Unexpected scenario hit with tab(" + activeInfo.tabId + ").");
            addTabToMRUAtFront(activeInfo.tabId);
        } else {
            putExistingTabToTop(activeInfo.tabId);
        }
    }
});

chrome.tabs.onCreated.addListener(function (tab) {
    CLUTlog("Tab create event fired with tab(" + tab.id + ")");
    addTabToMRUAtBack(tab.id);
});

chrome.tabs.onRemoved.addListener(function (tabId, removedInfo) {
    CLUTlog("Tab remove event fired from tab(" + tabId + ")");
    removeTabFromMRU(tabId);
});

chrome.storage.sync.get(
    {
        onlySameWindow: false
    },
    function (items) {
        options.onlySameWindow = items.onlySameWindow;
    }
);

chrome.storage.onChanged.addListener(function (changes) {
    for (let [key, { newValue }] of Object.entries(changes)) {
        options[key] = newValue;
    }
});

var addTabToMRUAtBack = function (tabId) {
    var index = mru.indexOf(tabId);
    if (index == -1) {
        //add to the end of mru
        mru.splice(-1, 0, tabId);
        saveMRUToStorage(); // Save MRU after modification
    }
};

var addTabToMRUAtFront = function (tabId) {
    CLUTlog("new to front", tabId);

    var index = mru.indexOf(tabId);
    if (index == -1) {
        //add to the front of mru
        mru.splice(0, 0, tabId);
        printMRUSimple();
        saveMRUToStorage(); // Save MRU after modification
    }
};
var putExistingTabToTop = function (tabId) {
    CLUTlog("existing to front", tabId);
    var index = mru.indexOf(tabId);
    if (index != -1) {
        mru.splice(index, 1);
        mru.unshift(tabId);
        printMRUSimple();
        saveMRUToStorage(); // Save MRU after modification
    }
};

var removeTabFromMRU = function (tabId) {
    var index = mru.indexOf(tabId);
    if (index != -1) {
        mru.splice(index, 1);
        saveMRUToStorage(); // Save MRU after modification
    }
};

var removeItemAtIndexFromMRU = function (index) {
    if (index < mru.length) {
        mru.splice(index, 1);
        saveMRUToStorage(); // Save MRU after modification
    }
};

var incrementSwitchCounter = function () {
    intSwitchCount = (intSwitchCount + 1) % mru.length;
};

var decrementSwitchCounter = function () {
    intSwitchCount = intSwitchCount == 0 ? mru.length - 1 : intSwitchCount - 1;
};

var initialize = function () {
    if (!initialized) {
        initialized = true;
        CLUTlog("Initializing CLUT extension");
        isExtensionReady = false; // Reset readiness flag during initialization
        
        // First check if we have a persisted state
        chrome.storage.local.get(['mruList'], function(result) {
            if (result.mruList && Array.isArray(result.mruList) && result.mruList.length > 0) {
                CLUTlog("Found persisted MRU list with " + result.mruList.length + " tabs");
                stateHasBeenPersisted = true;
                mru = result.mruList;
                lastSavedMRU = [...mru]; // Initialize last saved state
                validateMRUTabs(); // Validate the tabs in case some were closed while inactive
                
                // Set a short timeout to ensure everything is loaded before marking as ready
                setTimeout(function() {
                    isExtensionReady = true;
                    CLUTlog("Extension is ready for commands");
                }, 200);
            } else {
                CLUTlog("No persisted state found, building initial MRU list");
                refreshMRUFromCurrentTabs();
                
                // Set a short timeout to ensure everything is loaded before marking as ready
                setTimeout(function() {
                    isExtensionReady = true;
                    CLUTlog("Extension is ready for commands");
                }, 200);
            }
            
            // Start periodic saving
            startPeriodicSave();
        });
    }
};

var printMRUSimple = async function () {
    const tabs = await getTabs();
    CLUTlog(tabs.map((t) => `${t.index} - ${t.title}`));
};

async function getTabs() {
    const tabs = await Promise.all(
        (mru || []).map(
            (tabId) =>
                new Promise((resolve, reject) => {
                    chrome.tabs.get(tabId, (tab) => {
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else {
                            resolve(tab);
                        }
                    });
                })
        )
    );
    return tabs.filter(Boolean);
}

// Additionally listen for storage changes to detect if another instance updated the MRU
chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName === 'local' && changes.mruList && !slowSwitchOngoing && !fastSwitchOngoing) {
        // Only update if we're not in the middle of a switch operation
        CLUTlog("MRU list changed in storage, considering update");
        
        // If the new list is significantly different (not just our own update), restore it
        const newMRU = changes.mruList.newValue;
        if (Array.isArray(newMRU) && 
            (mru.length !== newMRU.length || 
             JSON.stringify(mru) !== JSON.stringify(newMRU))) {
            CLUTlog("Significant MRU change detected, updating local state");
            mru = newMRU;
        }
    }
});

initialize();
