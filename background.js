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

var isExtensionReady = false;

var saveMRUToStorage = function () {
    if (JSON.stringify(mru) === JSON.stringify(lastSavedMRU)) {
        CLUTlog("MRU unchanged, skipping save");
        return;
    }

    chrome.storage.local.set({ mruList: mru }, function () {
        if (chrome.runtime.lastError) {
            CLUTlog("Error saving MRU list: " + chrome.runtime.lastError.message);
            return;
        }
        CLUTlog("MRU list saved to storage, length: " + mru.length);
        lastSavedMRU = [...mru];
    });
};

var startPeriodicSave = function () {
    if (periodicSaveTimer) {
        clearInterval(periodicSaveTimer);
    }

    periodicSaveTimer = setInterval(() => {
        CLUTlog("Performing periodic MRU save");
        saveMRUToStorage();
    }, PERIODIC_SAVE_INTERVAL);

    CLUTlog("Started periodic MRU saving every " + PERIODIC_SAVE_INTERVAL / 1000 + " seconds");
};

var stopPeriodicSave = function () {
    if (!periodicSaveTimer) return;

    clearInterval(periodicSaveTimer);
    periodicSaveTimer = null;
    CLUTlog("Stopped periodic MRU saving");
};

var restoreMRUFromStorage = function () {
    chrome.storage.local.get(["mruList"], function (result) {
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

var validateMRUTabs = function (callback) {
    if (!mru || mru.length === 0) {
        CLUTlog("Empty MRU list, refreshing from current tabs");
        refreshMRUFromCurrentTabs();
        if (callback) callback();
        return;
    }

    if (callback) {
        chrome.tabs.get(mru[0], (tab) => {
            if (chrome.runtime.lastError) {
                CLUTlog("First tab in MRU is invalid, doing full validation");
                performFullValidation(callback);
                return;
            }
            CLUTlog("Quick validation passed");
            if (callback) callback();
        });
        return;
    }

    performFullValidation(callback);
};

var performFullValidation = function (callback) {
    const tabPromises = mru.map(
        (tabId) =>
            new Promise((resolve) => {
                chrome.tabs.get(tabId, (tab) => {
                    if (chrome.runtime.lastError) {
                        CLUTlog(`Tab ${tabId} no longer exists, will be removed from MRU`);
                        resolve(null);
                        return;
                    }
                    resolve(tabId);
                });
            })
    );

    Promise.all(tabPromises)
        .then((validTabIds) => {
            const newMRU = validTabIds.filter((tabId) => tabId !== null);

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
        })
        .catch((error) => {
            CLUTlog("Error validating MRU tabs:", error);
            refreshMRUFromCurrentTabs();
            if (callback) callback();
        });
};

var refreshMRUFromCurrentTabs = function () {
    mru = [];
    chrome.windows.getAll({ populate: true }, function (windows) {
        windows.forEach((window) => {
            window.tabs.forEach((tab) => mru.unshift(tab.id));
        });
        CLUTlog("MRU refreshed from current tabs: " + mru.length + " tabs");
        saveMRUToStorage();
        printMRUSimple();
    });
};

var CLUTlog = function (...args) {
    if (loggingOn) {
        console.log(...args);
    }
};

var printMRUSimple = async function () {
    const tabs = await getTabs();
    CLUTlog(tabs.map((t) => `${t.index} - ${t.title}`));
};

// Function to ensure extension is ready before processing commands
var ensureExtensionReady = function (callback) {
    if (isExtensionReady) {
        callback();
        return;
    }
    if (mru.length !== 0) {
        CLUTlog("MRU list already exists, proceeding with command");
        isExtensionReady = true;
        callback();
        return;
    }

    CLUTlog("Extension not ready yet - Empty MRU list, loading from storage");
    chrome.storage.local.get(["mruList"], function (result) {
        if (result.mruList && Array.isArray(result.mruList) && result.mruList.length > 0) {
            mru = result.mruList;
            CLUTlog("Loaded " + mru.length + " tabs for immediate command processing");
            isExtensionReady = true;
            callback();
            return;
        }

        chrome.windows.getAll({ populate: true }, function (windows) {
            mru = [];
            windows.forEach((window) => {
                window.tabs.forEach((tab) => mru.unshift(tab.id));
            });
            CLUTlog("Built new MRU list with " + mru.length + " tabs for immediate command");
            isExtensionReady = true;
            callback();
        });
    });
};

var processCommand = function (command) {
    CLUTlog("Command recd:" + command);

    ensureExtensionReady(function () {
        const isFastSwitch = command === "alt_switch_fast";
        slowswitchForward = command === "alt_switch_slow_forward";

        if (!slowSwitchOngoing && !fastSwitchOngoing) {
            fastSwitchOngoing = isFastSwitch;
            slowSwitchOngoing = !isFastSwitch;
            CLUTlog("CLUT::START_SWITCH");
            intSwitchCount = 0;
            doIntSwitch();
        } else if ((slowSwitchOngoing && !isFastSwitch) || (fastSwitchOngoing && isFastSwitch)) {
            CLUTlog("CLUT::DO_INT_SWITCH");
            doIntSwitch();
        } else {
            endSwitch();
            fastSwitchOngoing = isFastSwitch;
            slowSwitchOngoing = !isFastSwitch;
            CLUTlog("CLUT::START_SWITCH");
            intSwitchCount = 0;
            doIntSwitch();
        }

        if (timer) {
            clearTimeout(timer);
        }

        timer = setTimeout(endSwitch, isFastSwitch ? fasttimerValue : slowtimerValue);
    });
};

var doIntSwitch = function (recurseLevel = 0) {
    CLUTlog("CLUT:: in int switch, intSwitchCount: " + intSwitchCount + ", mru.length: " + mru.length);

    if (!(0 <= intSwitchCount && intSwitchCount < mru.length)) return;
    if (recurseLevel > mru.length) return;

    if (recurseLevel === 0) {
        return chrome.windows.getCurrent(function (currentWindow) {
            currentWindowId = currentWindow.id;
            doIntSwitch(1);
        });
    }

    slowswitchForward ? decrementSwitchCounter() : incrementSwitchCounter();
    const tabIdToMakeActive = mru[intSwitchCount];

    chrome.tabs.get(tabIdToMakeActive, function (tab) {
        if (!tab) {
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
            return;
        }

        if (options.onlySameWindow && tab.windowId !== currentWindowId) {
            doIntSwitch(recurseLevel + 1);
            return;
        }

        // Check if the tab is already active - if so, continue to next tab
        if (tab.active) {
            CLUTlog("CLUT:: tab is already active, continuing to next tab");
            doIntSwitch(recurseLevel + 1);
            return;
        }


        chrome.windows.update(tab.windowId, { focused: true });
        chrome.tabs.update(tabIdToMakeActive, { active: true, highlighted: true });
        lastIntSwitchIndex = intSwitchCount;
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

var addTabToMRUAtBack = function (tabId) {
    if (mru.indexOf(tabId) !== -1) return;

    mru.splice(-1, 0, tabId);
    saveMRUToStorage();
};

var addTabToMRUAtFront = function (tabId) {
    CLUTlog("new to front", tabId);
    if (mru.indexOf(tabId) !== -1) return;

    mru.splice(0, 0, tabId);
    printMRUSimple();
    saveMRUToStorage();
};

var putExistingTabToTop = function (tabId) {
    CLUTlog("existing to front", tabId);
    const index = mru.indexOf(tabId);
    if (index === -1) return;

    mru.splice(index, 1);
    mru.unshift(tabId);
    printMRUSimple();
    saveMRUToStorage();
};

var removeTabFromMRU = function (tabId) {
    const index = mru.indexOf(tabId);
    if (index === -1) return;

    mru.splice(index, 1);
    saveMRUToStorage();
};

var removeItemAtIndexFromMRU = function (index) {
    if (index >= mru.length) return;

    mru.splice(index, 1);
    saveMRUToStorage();
};

var incrementSwitchCounter = function () {
    intSwitchCount = (intSwitchCount + 1) % mru.length;
};

var decrementSwitchCounter = function () {
    intSwitchCount = intSwitchCount == 0 ? mru.length - 1 : intSwitchCount - 1;
};

var initialize = function () {
    if (initialized) return;

    initialized = true;
    CLUTlog("Initializing CLUT extension");
    isExtensionReady = false;

    chrome.storage.local.get(["mruList"], function (result) {
        if (result.mruList && Array.isArray(result.mruList) && result.mruList.length > 0) {
            CLUTlog("Found persisted MRU list with " + result.mruList.length + " tabs");
            stateHasBeenPersisted = true;
            mru = result.mruList;
            lastSavedMRU = [...mru];
            validateMRUTabs();

            setTimeout(() => {
                isExtensionReady = true;
                CLUTlog("Extension is ready for commands");
            }, 200);
            return;
        }

        CLUTlog("No persisted state found, building initial MRU list");
        refreshMRUFromCurrentTabs();

        setTimeout(() => {
            isExtensionReady = true;
            CLUTlog("Extension is ready for commands");
        }, 200);

        startPeriodicSave();
    });
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

// Listen for service worker lifecycle events
chrome.runtime.onStartup.addListener(function () {
    CLUTlog("Extension startup");
    initialize();
});

// Also handles extension installation and updates
chrome.runtime.onInstalled.addListener(function () {
    CLUTlog("Extension installed/updated");
    initialize();
});

// Additionally listen for storage changes to detect if another instance updated the MRU
chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === "local" && changes.mruList && !slowSwitchOngoing && !fastSwitchOngoing) {
        // Only update if we're not in the middle of a switch operation
        CLUTlog("MRU list changed in storage, considering update");

        // If the new list is significantly different (not just our own update), restore it
        const newMRU = changes.mruList.newValue;
        if (Array.isArray(newMRU) && (mru.length !== newMRU.length || JSON.stringify(mru) !== JSON.stringify(newMRU))) {
            CLUTlog("Significant MRU change detected, updating local state");
            mru = newMRU;
        }
    }
});

chrome.storage.onChanged.addListener(function (changes) {
    for (let [key, { newValue }] of Object.entries(changes)) {
        options[key] = newValue;
    }
});

chrome.commands.onCommand.addListener(processCommand);

chrome.action.onClicked.addListener(function (tab) {
    CLUTlog("Click recd");
    processCommand("alt_switch_fast");
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
    if (slowSwitchOngoing || fastSwitchOngoing) {
        return;
    }

    var index = mru.indexOf(activeInfo.tabId);

    //probably should not happen since tab created gets called first than activated for new tabs,
    // but added as a backup behavior to avoid orphan tabs
    if (index == -1) {
        CLUTlog("Unexpected scenario hit with tab(" + activeInfo.tabId + ").");
        ensureExtensionReady(() => addTabToMRUAtFront(activeInfo.tabId));
    } else {
        ensureExtensionReady(() => putExistingTabToTop(activeInfo.tabId));
    }
});

chrome.tabs.onCreated.addListener(function (tab) {
    CLUTlog("Tab create event fired with tab(" + tab.id + ")");
    ensureExtensionReady(() => addTabToMRUAtBack(tab.id));
});

chrome.tabs.onRemoved.addListener(function (tabId, removedInfo) {
    CLUTlog("Tab remove event fired from tab(" + tabId + ")");
    ensureExtensionReady(() => removeTabFromMRU(tabId));
});

chrome.storage.sync.get(
    {
        onlySameWindow: false
    },
    function (items) {
        options.onlySameWindow = items.onlySameWindow;
    }
);

initialize();
