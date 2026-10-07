startup-begin = Loading plugin
startup-finish = Plugin ready

prefs-title = MyZoteroTools

# ---- Features 1-3: collection aggregation & item list ----
column-source-collection = Source Subcollection
banner-aggregated = Aggregated: { $count } items from { $collections } subcollections

# ---- Feature 4: reading status ----
column-reading-status = Reading Status
reading-state-todo = To read
reading-state-doing = Reading
reading-state-done = Read

# Context menu. These are consumed by document.l10n, so they MUST use the
# .label attribute form. The main window's FTL is injected by
# hooks.onMainWindowLoad via insertFTLIfNeeded.
menu-reading-status =
    .label = Reading Status
menu-reading-state-todo =
    .label = Mark as to read
menu-reading-state-doing =
    .label = Mark as reading
menu-reading-state-done =
    .label = Mark as read
menu-reading-state-clear =
    .label = Clear status

# ---- Feature 5: export bundle ----
menu-export-bundle =
    .label = Export item bundle…
export-bundle-choose-folder = Choose the output folder for the bundle
export-bundle-start = Exporting item bundle
export-bundle-count = { $count } items
export-bundle-done = Bundle exported
export-bundle-result = { $count } items exported to { $dir }
export-bundle-failed = Bundle export failed

# ---- Feature 6: library audit ----
menu-library-audit =
    .label = Library audit (read-only: duplicate collections & items)…
audit-running = Auditing library…
audit-done = Library audit finished
audit-clean = No problems found ✅
audit-summary = { $count } problem group(s) found. Report generated and opened.
audit-failed = Library audit failed

# ---- Feature 8: metadata cleanup ----
menu-metadata-clean =
    .label = Clean metadata (strip HTML / normalize language)…
clean-nothing = No metadata needs cleaning ✅
clean-confirm-title = Confirm metadata cleanup
clean-confirm-body = This will modify { $items } item(s): { $html } HTML field(s) and { $language } language field(s).
clean-confirm-more = (only the first 6 changes are listed; the rest follow the same pattern)
clean-confirm-ok = Clean now
clean-done = Metadata cleanup finished
clean-done-detail = { $count } item(s) updated

# ---- Feature 9: update check (with proxy speed test) ----
menu-check-update =
    .label = Check for updates (with proxy speed test)…
update-checking = Checking for updates
update-probing = Speed-testing mirrors…
update-all-failed = No update source is reachable
update-all-failed-detail = Tried { $count } sources, none succeeded. Check your network or change the mirror list in settings.
update-check-failed = Update check failed
update-latest = You are up to date
update-latest-detail = Current { $version }, manifest from { $from } ({ $count } usable source(s))
update-available-title = New version available
update-available-body = Current { $current }, latest { $latest } (manifest from { $from }).
update-verify-note = Verification
update-verified-ok = Cross-checked { $a } against { $b } — both manifests match ✅
update-verified-mismatch = ⚠️ { $a } and { $b } returned different manifests — aborted (a mirror may be tampered with)
update-verified-unavailable = Only { $a } is reachable, cross-check not possible ⚠️
update-verified-direct = Fetched directly from GitHub, no third party ✅
update-verified-skipped = Cross-check is disabled
update-confirm-ok = Download it
update-downloading = Downloading the new version
update-downloading-detail = { $version } from { $from }
update-downloaded = New version downloaded
update-downloaded-detail = { $version } saved to { $path }. Install it via Tools → Add-ons → gear → Install Add-on From File.
update-download-failed = Download failed
update-hash-mismatch = The file from { $from } does not match the manifest hash — rejected (possible tampering)

# ---- Feature 7: structured fields ----
menu-structured-fields =
    .label = Structured fields
menu-export-selected-table =
    .label = Export comparison table (selected items)
menu-export-collection-table =
    .label = Export comparison table (all in current list)
menu-import-fields-csv =
    .label = Import from CSV…
section-structured-fields =
    .label = Structured fields
sidenav-structured-fields =
    .label = Structured fields
section-structured-fields-empty = No structured fields yet. Switch to edit mode to add some.
section-structured-fields-name = Field name
section-structured-fields-value = Value
section-structured-fields-add = Add
section-structured-fields-remove = Remove this field
structured-choose-folder = Choose the output folder for the comparison table
structured-choose-csv = Choose the CSV to import
structured-no-items = No items to export
structured-empty = The selected items have no structured fields
structured-empty-hint = Structured fields live in an item's Extra as "{ $prefix }Name: value"
structured-exported = Comparison table exported
structured-exported-detail = { $count } items exported to { $dir }
structured-failed = Operation failed
structured-import-empty = The CSV is empty
structured-import-no-key = The CSV has no "key" column
structured-import-no-key-hint = The first row must be a header including a column named "key" (the Zotero item key)
structured-imported = Import finished
structured-imported-detail = { $count } updated, { $skipped } skipped

# ---- Feature 10: literature intake (agent <-> Zotero bridge) ----
menu-intake-find-pdf =
    .label = Find missing PDFs for the task collection…
intake-no-collection = No task collection configured
intake-no-collection-hint = Set it in Edit → Settings → Daxiang Zotero Tools → Literature Intake, e.g. "除草剂" or "农药/国标".
intake-all-have-pdf = Every item in that collection already has a PDF
intake-searching = Finding available PDFs
intake-searching-detail = { $count } item(s) in "{ $name }" have no PDF; searching…

# ---- Extraction queue (PDF added -> notify downstream agent) ----
menu-intake-mark-extract =
    .label = Tag pending extraction items in the task collection…
intake-marked = Extraction tags applied
intake-marked-detail = { $count } item(s) in "{ $name }" newly tagged as pending extraction.
