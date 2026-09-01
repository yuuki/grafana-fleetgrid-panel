/**
 * Levitate ignore list for `grafana/plugin-actions/is-compatible`.
 *
 * Only ignore confirmed type-only false positives. Real API breaks must
 * still fail CI (`fail-if-incompatible: yes` in `.github/workflows/is-compatible.yml`).
 * Remove an entry when we adopt the Grafana version that introduced the change,
 * or when Levitate stops misreporting it. See #42.
 */
module.exports = {
  changes: [
    // Grafana 13 rewrote PanelMigrationHandler from an interface to a type
    // alias. Levitate reports this as an incompatible parameter change
    // ("-PanelMigrationHandler +type PanelMigrationHandler") even though
    // the call shape is unchanged. Grafana staff recommended ignoring it:
    // https://community.grafana.com/t/compatibility-check-failure/163073
    /PanelPlugin\.setMigrationHandler/,
  ],
};
