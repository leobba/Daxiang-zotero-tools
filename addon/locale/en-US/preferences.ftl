// Note: the visible text of checkbox / radio / menuitem MUST use the .label
// attribute form. As a plain value Fluent writes it into textContent, which
// leaves the control itself unrendered. Only description / html:h2 use plain values.

settings-tab-aggregation =
    .label = Aggregation
settings-tab-aggregation-intro = Lets a collection that has no items of its own but does have subcollections show those subcollections' items directly.
settings-tab-item-list =
    .label = Item List
settings-tab-item-list-intro = Adjust how the item list itself is displayed.
settings-tab-about =
    .label = About


setting-smart-recursion-mode = Aggregation mode
setting-smart-recursion-mode-desc = "Empty collections only" applies to collections with no items of their own; collections that already have items (such as "机器学习") are left untouched. "All collections" is equivalent to turning on Zotero's built-in global toggle.
setting-smart-recursion-mode-empty-only =
    .label = Empty collections only (recommended)
setting-smart-recursion-mode-always =
    .label = All collections
setting-smart-recursion-mode-off =
    .label = Off

setting-summary-banner =
    .label = Aggregation summary banner
setting-summary-banner-desc = When items are aggregated, shows a summary above the item list so you don't mistake them for items that really belong to the current collection.
setting-summary-banner-min-items = Minimum items for banner
setting-summary-banner-min-items-desc = Hide the banner when fewer items are aggregated than this. Use 0 to always show it.

setting-source-column =
    .label = "Source Subcollection" column
setting-source-column-desc = Adds a column showing which subcollection each item actually belongs to. If you don't see it, enable it from the column picker (right-click the item list header).
setting-source-column-separator = Separator between sources
setting-source-column-separator-desc = When an item belongs to several subcollections, their names are joined with this string. Leave empty to restore the default.
setting-source-column-separator-placeholder =
    .placeholder = default: space · space

settings-tab-reading-status =
    .label = Reading Status
settings-tab-reading-status-intro = Mark items as to-read / reading / read, and show the state as a column.
setting-reading-status =
    .label = Enable reading status
setting-reading-status-desc = Adds a "Reading Status" column and a set of marking commands to the item context menu. The state is stored as tags, so you can also filter by clicking them in the tag selector.
setting-reading-status-prefix = Status tag prefix
setting-reading-status-prefix-desc = The state is stored as a tag named prefix + state. Changing the prefix does not migrate existing tags.
setting-reading-status-prefix-placeholder =
    .placeholder = default: mzt/

settings-tab-export =
    .label = Export
settings-tab-export-intro = Export the selected items as a bundle, ready to be handed to an LLM for structured extraction or to be archived.
setting-export-enabled =
    .label = Enable "Export item bundle"
setting-export-enabled-desc = Adds an export command to the item context menu. The bundle contains an index.csv plus one Markdown file per item (metadata, abstract and fulltext).
setting-export-fulltext =
    .label = Include fulltext
setting-export-fulltext-desc = Fulltext comes from Zotero's own fulltext index cache, so PDFs are not re-parsed. Items that have not been indexed are marked as having no fulltext.
setting-export-output-dir = Default output folder
setting-export-output-dir-desc = If set, exports go straight to this folder without a dialog. Leave empty to be asked every time.
setting-export-output-dir-placeholder =
    .placeholder = leave empty to be asked

settings-tab-structured-fields =
    .label = Structured Fields
settings-tab-structured-fields-intro = Store variables extracted from papers (carrier, particle size, adjuvant…) on the item, and export them as a cross-paper comparison table.
setting-structured-enabled =
    .label = Enable structured fields
setting-structured-enabled-desc = Adds a "Structured fields" section to the item pane (editable) and export/import commands to the context menu. Data lives in the item's Extra, so it syncs with Zotero.
setting-structured-prefix = Field prefix
setting-structured-prefix-desc = Fields are stored in Extra as "prefix + name: value". Changing the prefix does not migrate existing data.
setting-structured-prefix-placeholder =
    .placeholder = default: mzt.
setting-structured-output-dir = Comparison table output folder
setting-structured-output-dir-desc = If set, exports go straight here. Leave empty to be asked every time.
setting-structured-output-dir-placeholder =
    .placeholder = leave empty to be asked

settings-tab-library-audit =
    .label = Library Audit
settings-tab-library-audit-intro = A read-only scan for duplicate collection trees, duplicate items, metadata pollution and more. It never modifies data.
setting-audit-enabled =
    .label = Enable library audit
setting-audit-enabled-desc = Adds an audit command to the Tools menu. Checks duplicate collection trees, duplicate items (including the ones Zotero's own detection misses), metadata pollution, empty collections, orphan attachments and items without attachments.
setting-audit-output-dir = Report output folder
setting-audit-output-dir-desc = Where the Markdown report is written. Leave empty to use the Zotero data directory.
setting-audit-output-dir-placeholder =
    .placeholder = leave empty for the data directory

settings-tab-metadata-clean =
    .label = Metadata Cleanup
settings-tab-metadata-clean-intro = Strip HTML that leaked into titles and unify the many spellings of the language field. Text only — no structural changes.
setting-clean-enabled =
    .label = Enable metadata cleanup
setting-clean-enabled-desc = Adds a cleanup command to the Tools menu. It scans first and shows a confirmation dialog listing exactly what will change.
setting-clean-html =
    .label = Strip HTML from title / publication
setting-clean-html-desc = Web captures often drag span/i tags into titles. Besides looking wrong, they break Zotero's own duplicate detection (the normalized titles no longer match). Cleaning them restores duplicate detection.
setting-clean-language =
    .label = Normalize the language field
setting-clean-language-desc = Collapses the many spellings of one language (zh / zh-CN / chi / 中文, en / eng / English) into BCP-47. This field affects CSL citation formatting. Unrecognized values are left untouched — nothing is guessed.

settings-tab-update-checker =
    .label = Update Check
settings-tab-update-checker-intro = Direct GitHub access is blocked on this machine, so update checks go through mirrors. Configure the mirror list here; the fastest one is picked at runtime.
setting-update-enabled =
    .label = Enable "Check for updates"
setting-update-enabled-desc = Adds a check-for-updates command to the Tools menu. It speed-tests every source first, fetches the version manifest from the fastest one, and cross-checks it against a second source.
setting-update-proxies = Mirror list
setting-update-proxies-desc = One prefix per line (e.g. https://gh-proxy.com/), or "direct" for a direct connection. Leave empty to use the built-in list of verified mirrors. All of them are speed-tested at runtime.
setting-update-proxies-placeholder =
    .placeholder = leave empty for the built-in list
setting-update-verify =
    .label = Cross-check the manifest
setting-update-verify-desc = Fetches the manifest from two different mirrors and compares version and hash; only continues if they agree. Mirrors are third-party intermediaries, so this guards against a single tampered mirror.
setting-update-download-dir = Download folder for new versions
setting-update-download-dir-desc = Where the downloaded xpi is saved. Leave empty to use the Zotero data directory.
setting-update-download-dir-placeholder =
    .placeholder = leave empty for the data directory

setting-about-body = This plugin only changes what you see. It never moves or copies items into the parent collection, and it does not change "Remove Item from Collection" behaviour.
settings-version = Version { $version }
