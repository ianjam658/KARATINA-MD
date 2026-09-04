/**
 * Central feature-gating config.
 * Anything NOT listed here defaults to PRO — so new commands are locked
 * by default until you explicitly mark them FREE. That matches the original
 * brief: view status / react / view messages / basic replies are free,
 * everything else needs to be unlocked.
 */

const TIERS = {
  FREE: "free",
  PRO: "pro"
};

const FEATURE_REQUIREMENTS = {
  viewMessages: TIERS.FREE,   // logging/reading incoming messages
  reactToMessage: TIERS.FREE, // auto-reacting to messages
  viewStatus: TIERS.FREE,     // marking contacts' statuses as viewed
  ping: TIERS.FREE,
  menu: TIERS.FREE,
  upgrade: TIERS.FREE,        // must stay free — it's how people pay!

  // Everything below is a paid example — add more PRO commands here.
  quote: TIERS.PRO
};

const TIER_RANK = {
  [TIERS.FREE]: 0,
  [TIERS.PRO]: 1
};

function hasAccess(userTier, featureName) {
  const required = FEATURE_REQUIREMENTS[featureName] ?? TIERS.PRO;
  const userRank = TIER_RANK[userTier] ?? 0;
  const requiredRank = TIER_RANK[required] ?? 1;
  return userRank >= requiredRank;
}

module.exports = { TIERS, FEATURE_REQUIREMENTS, hasAccess };
