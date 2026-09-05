/**
 * ============================================================
 * CYPHER-X FEATURE ACCESS SYSTEM
 * ============================================================
 *
 * FREE:
 * - Basic bot interaction
 * - View incoming messages
 * - Auto reactions
 * - Status viewing
 * - Ping
 * - Menu
 * - Upgrade
 *
 * PRO:
 * - Premium commands/features
 *
 * IMPORTANT:
 * Any feature not explicitly listed below is PRO by default.
 * This prevents accidentally making a new premium feature free.
 */
const TIERS = Object.freeze({
  FREE: "free",
  PRO: "pro"
});
// ============================================================
// FEATURE REQUIREMENTS
// ============================================================
const FEATURE_REQUIREMENTS = Object.freeze({
  // -------------------------
  // FREE FEATURES
  // -------------------------
  viewMessages: TIERS.FREE,
  reactToMessage: TIERS.FREE,
  viewStatus: TIERS.FREE,
  ping: TIERS.FREE,
  menu: TIERS.FREE,
  upgrade: TIERS.FREE,
  welcomeMembers: TIERS.FREE,
  // -------------------------
  // PRO FEATURES
  // -------------------------
  quote: TIERS.PRO,
  sticker: TIERS.PRO,
  qr: TIERS.PRO,
  download: TIERS.PRO,
  groupTools: TIERS.PRO,
  statusReact: TIERS.PRO,
  statusForward: TIERS.PRO,
  antiDelete: TIERS.PRO,
  viewOnce: TIERS.PRO,
  callReject: TIERS.PRO,
  channelReact: TIERS.PRO
  // Add future PRO features here, for example:
  //
  // ai: TIERS.PRO,
  // ownerTools: TIERS.PRO
});
// ============================================================
// TIER RANKING
// ============================================================
const TIER_RANK = Object.freeze({
  [TIERS.FREE]: 0,
  [TIERS.PRO]: 1
});
// ============================================================
// CHECK FEATURE ACCESS
// ============================================================
function hasAccess(userTier, featureName) {
  // Unknown features are PRO by default.
  const requiredTier =
    FEATURE_REQUIREMENTS[featureName] ?? TIERS.PRO;
  const userRank =
    TIER_RANK[userTier] ?? TIER_RANK[TIERS.FREE];
  const requiredRank =
    TIER_RANK[requiredTier] ?? TIER_RANK[TIERS.PRO];
  return userRank >= requiredRank;
}
// ============================================================
// GET REQUIRED TIER
// ============================================================
function getRequiredTier(featureName) {
  return (
    FEATURE_REQUIREMENTS[featureName] ??
    TIERS.PRO
  );
}
// ============================================================
// CHECK WHETHER A TIER EXISTS
// ============================================================
function isValidTier(tier) {
  return Object.values(TIERS).includes(tier);
}
// ============================================================
// EXPORT
// ============================================================
module.exports = {
  TIERS,
  FEATURE_REQUIREMENTS,
  TIER_RANK,
  hasAccess,
  getRequiredTier,
  isValidTier
};
