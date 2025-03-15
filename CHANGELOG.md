# Changelog
All notable changes to the CLUT (Cycle Last Used Tabs) extension will be documented in this file.

## [2.2] - 2023
### Fixed
- Solved the tab history loss issue when the extension becomes inactive in Manifest V3
- Implemented persistent state saving to preserve the MRU (Most Recently Used) tab list
- Added automatic tab list validation to handle closed tabs gracefully

### Improved
- Enhanced tab switching reliability after browser restarts
- Added background state saving to prevent data loss
- Optimized memory usage and service worker performance

## [2.1] - 2023
### Added
- Migrated to Manifest V3
- Added option to cycle tabs on active window only
- Improved tracking clarity 