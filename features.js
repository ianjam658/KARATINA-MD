/**
 * ============================================================
 * CYPHER-X FEATURE ACCESS SYSTEM
 * ============================================================
 */

const TIERS = Object.freeze({
  FREE: "free",
  PRO: "pro"
});

// ============================================================
// FEATURE REQUIREMENTS
// ============================================================

const FEATURE_REQUIREMENTS = Object.freeze({

  // FREE
  viewMessages: TIERS.FREE,
  reactToMessage: TIERS.FREE,
  viewStatus: TIERS.FREE,

  ping: TIERS.FREE,
  menu: TIERS.FREE,
  upgrade: TIERS.FREE,

  // PRO
  quote: TIERS.PRO
});

// ============================================================
// TIER RANKING
// ============================================================

const TIER_RANK = Object.freeze({
  [TIERS.FREE]: 0,
  [TIERS.PRO]: 1
});

// ============================================================
// CHECK ACCESS
// ============================================================

function hasAccess(userTier, featureName) {
  const requiredTier =
    FEATURE_REQUIREMENTS[featureName] ?? TIERS.PRO;

  const userRank =
    TIER_RANK[userTier] ?? TIER_RANK[TIERS.FREE];

  const requiredRank =
    TIER_RANK[requiredTier] ?? TIER_RANK[TIERS.PRO];

  return userRank >= requiredRank;
}

// ============================================================
// REQUIRED TIER
// ============================================================

function getRequiredTier(featureName) {
  return (
    FEATURE_REQUIREMENTS[featureName] ??
    TIERS.PRO
  );
}

// ============================================================
// VALID TIER
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
