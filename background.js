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

var slowswitchForward = false;

var initialized = false;
var options = {};
var currentWindowId;

var loggingOn = true;

var CLUTlog = function (...args) {
    if (loggingOn) {
        console.log(...args);
    }
};

var processCommand = function (command) {
    CLUTlog("Command recd:" + command);
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
};

chrome.commands.onCommand.addListener(processCommand);

chrome.action.onClicked.addListener(function (tab) {
    CLUTlog("Click recd");
    processCommand("alt_switch_fast");
});

chrome.runtime.onStartup.addListener(function () {
    CLUTlog("on startup");
    initialize();
});

chrome.runtime.onInstalled.addListener(function () {
    CLUTlog("on startup");
    initialize();
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
    }
};

var addTabToMRUAtFront = function (tabId) {
    CLUTlog("new to front", tabId);

    var index = mru.indexOf(tabId);
    if (index == -1) {
        //add to the front of mru
        mru.splice(0, 0, tabId);
        printMRUSimple();
    }
};
var putExistingTabToTop = function (tabId) {
    CLUTlog("existing to front", tabId);
    var index = mru.indexOf(tabId);
    if (index != -1) {
        mru.splice(index, 1);
        mru.unshift(tabId);
        printMRUSimple();
    }
};

var removeTabFromMRU = function (tabId) {
    var index = mru.indexOf(tabId);
    if (index != -1) {
        mru.splice(index, 1);
    }
};

var removeItemAtIndexFromMRU = function (index) {
    if (index < mru.length) {
        mru.splice(index, 1);
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
        chrome.windows.getAll({ populate: true }, function (windows) {
            windows.forEach(function (window) {
                window.tabs.forEach(function (tab) {
                    mru.unshift(tab.id);
                });
            });
            CLUTlog("MRU after init: " + mru);
            printMRUSimple();
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

initialize();
