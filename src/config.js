/**
 * STAT — Configuration
 * All user-editable settings live here. No other file needs changing
 * for normal operation.
 */

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD WATCH GROUPS
// Evaluated top-to-bottom. First matching group determines priority.
// P1 = Pushover HIGH priority (breaks through Do Not Disturb, siren sound)
// P2 = Pushover normal priority
// P3 = Email only (no push)
// ─────────────────────────────────────────────────────────────────────────────
export const WATCH_GROUPS = [
  // ── Epic at a hospital / health system (P1) ──────────────────────────────
  // Preferred destination. Always siren-push when keyword matches.
  // STAT's hospital system DO watchlist covers these employers directly —
  // if it fires from a hospital system, it's the real thing.
  {
    priority: 1,
    label: 'Epic · Health System',
    keywords: [
      'epic analyst', 'epic ambulatory', 'epiccare', 'epic application analyst',
      'epic build', 'epic implementation', 'ehr analyst', 'ehr application analyst',
      'clarity sql', 'clinical informatics analyst', 'healthcare it analyst',
      'health informatics analyst', 'epic inpatient', 'epic cadence',
      'epic resolute', 'epic beacon', 'epic radiant', 'epic willow',
      'epic optime', 'epic stork', 'epic clindoc', 'epic orders',
    ],
    // Only apply to jobs from health systems — consulting firms handled below.
    // Matched by company name substring (lowercase). If a job company name
    // contains any of these terms, it stays P1. Otherwise downgraded to P2
    // and chemistry check (fit score) determines if it gets pushed.
    // Empty = all companies treated equally (fallback if not using company filter).
    companyFilter: {
      // Jobs from these company name patterns stay P1 without needing high fit score
      health_system_hints: [
        'health', 'hospital', 'medical center', 'medical centre', 'clinic',
        'healthcare', 'medicine', 'physician', 'care center', 'care centre',
        'health system', 'health network', 'health plan', 'health sciences',
        'memorial', 'baptist', 'presbyterian', 'methodist', 'adventist',
        'ascension', 'dignity', 'intermountain', 'providence', 'kaiser',
        'ucsf', 'mayo', 'geisinger', 'sanford', 'vanderbilt', 'atrium',
      ],
      // Jobs from these company name patterns are consulting — use P2 + chemistry check
      consulting_hints: [
        'consulting', 'consultancy', 'advisors', 'advisory', 'solutions',
        'partners', 'staffing', 'technology', 'technologies', 'services',
        'implement', 'accenture', 'deloitte', 'cognizant', 'optum', 'leidos',
        'nordic', 'guidehouse', 'huron', 'chartis', 'netsmart', 'tegria',
        'divurgent', 'inovalon', 'evolent',
      ],
    },
  },

  // ── Epic at a consulting firm (P2 by default, upgrades to P1 on strong fit) ─
  // Consulting firms are good options only if there's genuine chemistry —
  // the resume fit score determines whether it's worth the siren push.
  // A consulting match scoring 8+ (min_score_for_p1) will still get P1 treatment.
  // A consulting match scoring 5 goes to email only. No noise.
  {
    priority: 2,
    label: 'Epic · Consulting (fit-gated)',
    keywords: [
      // Consulting-specific framing — these phrases rarely appear in health system postings
      'epic consultant', 'ehr consultant', 'health it consultant',
      'healthcare it consultant', 'epic contractor', 'epic contract',
      'traveling epic', 'remote epic consultant',
    ],
  },

  // ── Remote Customer Service (P1) ─────────────────────────────────────────
  // High-volume remote hiring, fast-moving — warrants immediate alert
  {
    priority: 1,
    label: 'Remote Customer Service',
    keywords: [
      'remote customer service', 'remote customer success', 'remote customer support',
      'remote client success', 'remote client services', 'customer service remote',
      'customer success remote', 'customer support remote',
      'work from home customer service', 'work from home customer support',
      'wfh customer service', 'virtual customer service', 'virtual customer support',
      'contact center remote', 'call center remote', 'remote service advisor',
      'remote member services', 'remote account manager', 'remote client relationship',
    ],
  },

  // ── Logistics & Supply Chain (P1) ─────────────────────────────────────────
  {
    priority: 1,
    label: 'Logistics / Supply Chain',
    keywords: [
      'logistics coordinator remote', 'logistics analyst remote',
      'supply chain analyst remote', 'supply chain coordinator remote',
      'remote logistics', 'remote supply chain', 'freight coordinator remote',
      'transportation coordinator remote', 'dispatch coordinator remote',
      'operations coordinator remote', 'fulfillment analyst',
      'inventory analyst remote', 'procurement analyst remote',
      'vendor coordinator remote', 'carrier relations remote',
      'last mile remote', 'shipping coordinator remote',
    ],
  },

  // ── Data / Analytics (P2) ─────────────────────────────────────────────────
  {
    priority: 2,
    label: 'Data / SQL / Analytics',
    keywords: [
      'data analyst', 'healthcare data analyst', 'sql analyst',
      'business intelligence analyst', 'bi analyst', 'data engineer',
      'clinical data analyst', 'reporting analyst', 'operations analyst',
      'business analyst remote',
    ],
  },

  // ── Product / Project / IT (P3) ───────────────────────────────────────────
  {
    priority: 3,
    label: 'Product / Project / IT',
    keywords: [
      'product manager', 'it project manager', 'systems analyst',
      'it analyst', 'technical analyst', 'implementation consultant',
      'operations manager remote', 'process improvement remote',
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// WORK ENVIRONMENT FILTER
// ─────────────────────────────────────────────────────────────────────────────
export const ENVIRONMENTS = ['remote', 'hybrid'];

// ─────────────────────────────────────────────────────────────────────────────
// GHOST JOB FILTER THRESHOLDS
// ─────────────────────────────────────────────────────────────────────────────
export const GHOST = {
  warn_after_days: 21,
  suppress_after_days: 90,
};

// ─────────────────────────────────────────────────────────────────────────────
// DO POLL INTERVALS (milliseconds)
// ─────────────────────────────────────────────────────────────────────────────
export const POLL_INTERVALS = {
  greenhouse:     30_000,
  lever:          30_000,
  ashby:          30_000,
  workday:        60_000,
  icims:          60_000,
  successfactors: 90_000,
  taleo:          120_000,
  hiringcafe:     60_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// KV KEYS
// ─────────────────────────────────────────────────────────────────────────────
export const KV = {
  seen_jobs:      'stat:seen_job_ids',
  company_list:   'stat:company_watchlist',
  do_registry:    'stat:do_registry',
  match_counts:   'stat:match_counts',       // company learning tracker
  resume_profile: 'stat:resume_profile',     // stored profile for fit scoring
  max_seen:       5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// RESUME FIT SCORING
// When ANTHROPIC_API_KEY is set and a profile is stored (POST /profile),
// every incoming alert is scored against the profile before dispatch.
// Low-scoring matches are demoted to email-only regardless of keyword priority.
// ─────────────────────────────────────────────────────────────────────────────
export const FIT_SCORING = {
  enabled: true,
  // Below this score → email only, no Pushover (regardless of keyword priority)
  min_score_for_push: 6,
  // P1 keyword match ALSO needs this score to get the high-priority siren push
  min_score_for_p1: 7,
  // Haiku is fast and cheap for structured JSON scoring
  model: 'claude-haiku-4-5-20251001',
};

// ─────────────────────────────────────────────────────────────────────────────
// COMPANY LEARNING & PROMOTION
// HiringCafe wide-net discovers employers automatically.
// After promote_after_matches matches within promote_window_ms, the company
// gets promoted to a persistent DO (direct 30-120s ATS polling).
// The watchlist grows itself — you never need to enumerate employers upfront.
// ─────────────────────────────────────────────────────────────────────────────
export const LEARNING = {
  promote_after_matches: 2,
  promote_window_ms: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// ─────────────────────────────────────────────────────────────────────────────
// HIRINGCAFE WIDE-NET SCRAPE
// ─────────────────────────────────────────────────────────────────────────────
export const HIRINGCAFE = {
  environments: ['remote', 'hybrid'],
  search_terms: [
    // Healthcare IT
    'epic analyst', 'epic ambulatory', 'ehr analyst',
    'clarity sql', 'healthcare it analyst',
    // Remote customer service
    'remote customer service', 'remote customer success',
    'virtual customer support', 'work from home customer service',
    'remote contact center',
    // Logistics / supply chain
    'remote logistics coordinator', 'remote supply chain',
    'logistics analyst remote', 'remote freight coordinator',
    'remote operations coordinator',
    // Data
    'data analyst', 'remote business analyst',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// SEED COMPANY WATCHLIST
// Format: { name, ats, token, url? }
// ─────────────────────────────────────────────────────────────────────────────
export const SEED_COMPANIES = [
  // ── Epic consulting firms (Greenhouse / Lever) ────────────────────────────
  { name: 'Nordic Consulting',       ats: 'greenhouse', token: 'nordicglobal' },
  { name: 'Guidehouse',              ats: 'greenhouse', token: 'guidehouse' },
  { name: 'Huron Consulting',        ats: 'greenhouse', token: 'huron' },
  { name: 'Impact Advisors',         ats: 'greenhouse', token: 'impactadvisors' },
  { name: 'Optimum Healthcare IT',   ats: 'greenhouse', token: 'optimumhealthcareit' },
  { name: 'Divurgent',               ats: 'greenhouse', token: 'divurgent' },
  { name: 'Tegria',                  ats: 'greenhouse', token: 'tegria' },
  { name: 'Pivot Point Consulting',  ats: 'greenhouse', token: 'pivotpointconsulting' },
  { name: 'Leidos Health',           ats: 'greenhouse', token: 'leidos' },
  { name: 'Accenture',               ats: 'greenhouse', token: 'accenture' },
  { name: 'Deloitte',                ats: 'greenhouse', token: 'deloitte' },
  { name: 'Optum',                   ats: 'greenhouse', token: 'optum' },
  { name: 'Cognizant',               ats: 'greenhouse', token: 'cognizant' },
  { name: 'Evolent Health',          ats: 'greenhouse', token: 'evolenthealth' },
  { name: 'Health Catalyst',         ats: 'greenhouse', token: 'healthcatalyst' },
  { name: 'Inovalon',                ats: 'greenhouse', token: 'inovalon' },
  { name: 'Netsmart',                ats: 'lever',      token: 'netsmart' },
  { name: 'Chartis Group',           ats: 'lever',      token: 'chartisgroup' },
  { name: 'S&P Consultants',         ats: 'lever',      token: 'spconsultants' },
  { name: 'Engage (Meditech)',        ats: 'ashby',      token: 'engage' },

  // ── Health systems — Workday ──────────────────────────────────────────────
  { name: 'Johns Hopkins',      ats: 'workday', token: 'jhhs',
    url: 'https://jhhs.wd5.myworkdayjobs.com/en-US/JHH_External_Positions' },
  { name: 'Mayo Clinic',        ats: 'workday', token: 'mayoclinic',
    url: 'https://mayoclinic.wd5.myworkdayjobs.com/en-US/mayoclinic' },
  { name: 'Kaiser Permanente',  ats: 'workday', token: 'kaiserpermanente',
    url: 'https://kp.wd5.myworkdayjobs.com/en-US/KP_External_Career_Site' },
  { name: 'Cleveland Clinic',   ats: 'workday', token: 'clevelandclinic',
    url: 'https://jobs.clevelandclinic.org' },
  { name: 'Mass General Brigham', ats: 'workday', token: 'massgeneralbrigham',
    url: 'https://massgeneralbrigham.wd1.myworkdayjobs.com/en-US/MGB_External' },
  { name: 'Penn Medicine',      ats: 'workday', token: 'pennmedicine',
    url: 'https://uphs.wd5.myworkdayjobs.com/en-US/UPHS' },
  { name: 'UCSF Health',        ats: 'workday', token: 'ucsf',
    url: 'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=6495&siteid=5861' },
  { name: 'Vanderbilt Health',  ats: 'workday', token: 'vanderbilt',
    url: 'https://vanderbilt.wd5.myworkdayjobs.com/en-US/ext-vumc' },
  { name: 'AdventHealth',       ats: 'workday', token: 'adventhealth',
    url: 'https://adventhealth.wd1.myworkdayjobs.com/en-US/AdventHealthCareers' },
  { name: 'Ascension',          ats: 'workday', token: 'ascension',
    url: 'https://ascension.wd1.myworkdayjobs.com/en-US/Ascension_Careers' },
  { name: 'CommonSpirit Health', ats: 'workday', token: 'commonspirit',
    url: 'https://commonspirit.wd5.myworkdayjobs.com/en-US/CommonSpiritHealthExternal' },
  { name: 'Intermountain Health', ats: 'workday', token: 'intermountain',
    url: 'https://intermountain.wd5.myworkdayjobs.com/en-US/enterprise' },
  { name: 'Atrium Health',      ats: 'workday', token: 'atriumhealth',
    url: 'https://atriumhealth.wd5.myworkdayjobs.com/en-US/Atrium_Health' },
  { name: 'Geisinger',          ats: 'workday', token: 'geisinger',
    url: 'https://geisinger.wd5.myworkdayjobs.com/en-US/MyGeisingerCareers' },
  { name: 'Sanford Health',     ats: 'workday', token: 'sanfordhealth',
    url: 'https://sanfordhealth.wd5.myworkdayjobs.com/en-US/SanfordCareers' },
  { name: 'OU Health',          ats: 'workday', token: 'ouhealth',
    url: 'https://oumedicine.wd5.myworkdayjobs.com/en-US/OUHealthCareers' },
  { name: 'Houston Methodist',  ats: 'workday', token: 'houstonmethodist',
    url: 'https://houstonmethodist.wd12.myworkdayjobs.com/en-US/GTI' },
  { name: 'WashU Medicine',     ats: 'workday', token: 'washu',
    url: 'https://wustl.wd1.myworkdayjobs.com/en-US/external' },
  { name: 'Boston Medical Center', ats: 'workday', token: 'bmc',
    url: 'https://bmc.wd1.myworkdayjobs.com/en-US/BMC' },
  { name: 'CVS Health',         ats: 'workday', token: 'cvshealth',
    url: 'https://cvshealth.wd1.myworkdayjobs.com/en-US/cvs_health_careers' },
  { name: 'Enloe Health',       ats: 'workday', token: 'enloe',
    url: 'https://enloe.wd12.myworkdayjobs.com/en-US/EnloeHealth' },
  { name: 'Jupiter Medical Center', ats: 'workday', token: 'jupitermed',
    url: 'https://jupitermed.wd1.myworkdayjobs.com/en-US/external' },

  // ── Health systems — iCIMS ────────────────────────────────────────────────
  { name: 'Dignity Health',  ats: 'icims', token: 'dignityhealth',
    url: 'https://careers-dignityhealth.icims.com/jobs/search?in_iframe=1' },
  { name: 'Tenet Healthcare', ats: 'icims', token: 'tenethealth',
    url: 'https://careers-tenethealth.icims.com/jobs/search?in_iframe=1' },
  { name: 'HCA Healthcare',  ats: 'icims', token: 'hca',
    url: 'https://careers-hca.icims.com/jobs/search?in_iframe=1' },

  // ── Health systems — SAP SuccessFactors ───────────────────────────────────
  { name: 'Baylor Scott & White', ats: 'successfactors', token: 'bswh',
    url: 'https://career4.successfactors.com/career?company=bswh&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Providence Health', ats: 'successfactors', token: 'providence',
    url: 'https://career4.successfactors.com/career?company=providence&career_ns=job_listing_summary&resultType=XML' },

  // ── Health systems — Oracle Taleo ─────────────────────────────────────────
  { name: 'UAB Medicine', ats: 'taleo', token: 'uab',
    url: 'https://uab.taleo.net/careersection/ext/jobsearch.ftl' },
  { name: 'Indiana University Health', ats: 'taleo', token: 'iuhealth',
    url: 'https://iuhealth.taleo.net/careersection/2/jobsearch.ftl' },
];
