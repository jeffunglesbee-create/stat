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
  {
    priority: 1,
    label: 'Epic / EHR / Healthcare IT',
    keywords: [
      'epic analyst',
      'epic ambulatory',
      'epiccare',
      'epic application analyst',
      'epic build',
      'epic consultant',
      'epic implementation',
      'ehr analyst',
      'ehr application analyst',
      'clarity sql',
      'clinical informatics analyst',
      'healthcare it analyst',
      'health informatics analyst',
      'epic inpatient',
      'epic cadence',
      'epic resolute',
      'epic beacon',
      'epic radiant',
      'epic willow',
      'epic optime',
      'epic stork',
      'epic clindoc',
      'epic orders',
    ],
  },
  {
    priority: 2,
    label: 'Data / SQL / Analytics',
    keywords: [
      'data analyst',
      'healthcare data analyst',
      'sql analyst',
      'business intelligence analyst',
      'bi analyst',
      'data engineer',
      'clinical data analyst',
      'reporting analyst',
    ],
  },
  {
    priority: 3,
    label: 'Product / Project / IT',
    keywords: [
      'product manager',
      'it project manager',
      'systems analyst',
      'it analyst',
      'technical analyst',
      'implementation consultant',
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// WORK ENVIRONMENT FILTER
// 'remote' | 'hybrid' | ['remote', 'hybrid'] | null (any)
// ─────────────────────────────────────────────────────────────────────────────
export const ENVIRONMENTS = ['remote', 'hybrid'];

// ─────────────────────────────────────────────────────────────────────────────
// GHOST JOB FILTER THRESHOLDS
// STAT sources directly from ATS — jobs are confirmed live at the source.
// Ghost risk = staleness. Jobs posted long ago are flagged, not suppressed.
// ─────────────────────────────────────────────────────────────────────────────
export const GHOST = {
  // Days after which a job gets a [⚠️ X days old — verify] warning in alerts
  warn_after_days: 21,
  // Days after which to suppress alerts entirely (job is almost certainly stale)
  suppress_after_days: 90,
  // Healthcare/Epic note: legitimate niche roles do take longer to fill,
  // so we warn rather than suppress at 21 days and only suppress at 90.
};

// ─────────────────────────────────────────────────────────────────────────────
// DO POLL INTERVALS (milliseconds)
// Each CompanyWatcherDO reschedules its own alarm after each run.
// Healthcare systems (Workday/iCIMS) are slower-updating — poll less often.
// ─────────────────────────────────────────────────────────────────────────────
export const POLL_INTERVALS = {
  greenhouse: 30_000,    // 30s — clean public JSON API, low cost
  lever:      30_000,    // 30s — clean public JSON API, low cost
  ashby:      30_000,    // 30s — clean public JSON API, low cost
  workday:    60_000,    // 60s — SSR payload parse, be polite
  icims:      60_000,    // 60s — sitemap.xml parse
  successfactors: 90_000, // 90s — XML feed
  taleo:      120_000,   // 120s — HTML parse, most fragile
  hiringcafe: 60_000,    // 60s — wide-net scrape (cron-driven, not DO)
};

// ─────────────────────────────────────────────────────────────────────────────
// KV KEYS
// ─────────────────────────────────────────────────────────────────────────────
export const KV = {
  seen_jobs:    'stat:seen_job_ids',     // JSON array of seen IDs
  company_list: 'stat:company_watchlist', // JSON array of company configs
  do_registry:  'stat:do_registry',      // JSON map of active DO stubs
  max_seen:     5000,                    // trim oldest when over this
};

// ─────────────────────────────────────────────────────────────────────────────
// HIRINGCAFE SCRAPE (cron fallback — catches employers not in the DO watchlist)
// ─────────────────────────────────────────────────────────────────────────────
export const HIRINGCAFE = {
  environments: ['remote', 'hybrid'],
  // Top 2 keywords per priority group used for broad scrape
  // (keyword matching done locally after fetch — HiringCafe search is imprecise)
  search_terms: [
    'epic analyst',
    'epic ambulatory',
    'ehr analyst',
    'clarity sql',
    'healthcare it analyst',
    'data analyst',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// SEED COMPANY WATCHLIST
// These companies are loaded into the DO system on first deploy.
// Format: { name, ats, token, url? }
// token = the company's ATS board slug/tenant ID
// url   = full override URL (for iCIMS, Taleo, SuccessFactors, Workday)
// ─────────────────────────────────────────────────────────────────────────────
export const SEED_COMPANIES = [
  // ── Epic consulting firms (Greenhouse / Lever) ────────────────────────────
  { name: 'Nordic Consulting',       ats: 'greenhouse',  token: 'nordicglobal' },
  { name: 'Guidehouse',              ats: 'greenhouse',  token: 'guidehouse' },
  { name: 'Huron Consulting',        ats: 'greenhouse',  token: 'huron' },
  { name: 'Impact Advisors',         ats: 'greenhouse',  token: 'impactadvisors' },
  { name: 'Optimum Healthcare IT',   ats: 'greenhouse',  token: 'optimumhealthcareit' },
  { name: 'Divurgent',               ats: 'greenhouse',  token: 'divurgent' },
  { name: 'Tegria',                  ats: 'greenhouse',  token: 'tegria' },
  { name: 'Pivot Point Consulting',  ats: 'greenhouse',  token: 'pivotpointconsulting' },
  { name: 'Leidos Health',           ats: 'greenhouse',  token: 'leidos' },
  { name: 'Accenture',               ats: 'greenhouse',  token: 'accenture' },
  { name: 'Deloitte',                ats: 'greenhouse',  token: 'deloitte' },
  { name: 'Optum',                   ats: 'greenhouse',  token: 'optum' },
  { name: 'Cognizant',               ats: 'greenhouse',  token: 'cognizant' },
  { name: 'Evolent Health',          ats: 'greenhouse',  token: 'evolenthealth' },
  { name: 'Health Catalyst',         ats: 'greenhouse',  token: 'healthcatalyst' },
  { name: 'Inovalon',                ats: 'greenhouse',  token: 'inovalon' },
  { name: 'Netsmart',                ats: 'lever',       token: 'netsmart' },
  { name: 'Chartis Group',           ats: 'lever',       token: 'chartisgroup' },
  { name: 'S&P Consultants',         ats: 'lever',       token: 'spconsultants' },
  { name: 'Engage (Meditech)',        ats: 'ashby',       token: 'engage' },

  // ── Health systems — Workday ──────────────────────────────────────────────
  // tenant = the subdomain before .myworkdayjobs.com
  { name: 'Johns Hopkins',           ats: 'workday', token: 'jhhs',
    url: 'https://jhhs.wd5.myworkdayjobs.com/en-US/JHH_External_Positions' },
  { name: 'Mayo Clinic',             ats: 'workday', token: 'mayoclinic',
    url: 'https://mayoclinic.wd5.myworkdayjobs.com/en-US/mayoclinic' },
  { name: 'Kaiser Permanente',       ats: 'workday', token: 'kaiserpermanente',
    url: 'https://kp.wd5.myworkdayjobs.com/en-US/KP_External_Career_Site' },
  { name: 'Cleveland Clinic',        ats: 'workday', token: 'clevelandclinic',
    url: 'https://jobs.clevelandclinic.org' },
  { name: 'Mass General Brigham',    ats: 'workday', token: 'massgeneralbrigham',
    url: 'https://massgeneralbrigham.wd1.myworkdayjobs.com/en-US/MGB_External' },
  { name: 'Penn Medicine',           ats: 'workday', token: 'pennmedicine',
    url: 'https://uphs.wd5.myworkdayjobs.com/en-US/UPHS' },
  { name: 'UCSF Health',             ats: 'workday', token: 'ucsf',
    url: 'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=6495&siteid=5861' },
  { name: 'Vanderbilt Health',       ats: 'workday', token: 'vanderbilt',
    url: 'https://vanderbilt.wd5.myworkdayjobs.com/en-US/ext-vumc' },
  { name: 'AdventHealth',            ats: 'workday', token: 'adventhealth',
    url: 'https://adventhealth.wd1.myworkdayjobs.com/en-US/AdventHealthCareers' },
  { name: 'Ascension',               ats: 'workday', token: 'ascension',
    url: 'https://ascension.wd1.myworkdayjobs.com/en-US/Ascension_Careers' },
  { name: 'CommonSpirit Health',     ats: 'workday', token: 'commonspirit',
    url: 'https://commonspirit.wd5.myworkdayjobs.com/en-US/CommonSpiritHealthExternal' },
  { name: 'Intermountain Health',    ats: 'workday', token: 'intermountain',
    url: 'https://intermountain.wd5.myworkdayjobs.com/en-US/enterprise' },
  { name: 'Atrium Health',           ats: 'workday', token: 'atriumhealth',
    url: 'https://atriumhealth.wd5.myworkdayjobs.com/en-US/Atrium_Health' },
  { name: 'Geisinger',               ats: 'workday', token: 'geisinger',
    url: 'https://geisinger.wd5.myworkdayjobs.com/en-US/MyGeisingerCareers' },
  { name: 'Sanford Health',          ats: 'workday', token: 'sanfordhealth',
    url: 'https://sanfordhealth.wd5.myworkdayjobs.com/en-US/SanfordCareers' },
  { name: 'OU Health',               ats: 'workday', token: 'ouhealth',
    url: 'https://oumedicine.wd5.myworkdayjobs.com/en-US/OUHealthCareers' },
  { name: 'Houston Methodist',       ats: 'workday', token: 'houstonmethodist',
    url: 'https://houstonmethodist.wd12.myworkdayjobs.com/en-US/GTI' },
  { name: 'WashU Medicine',          ats: 'workday', token: 'washu',
    url: 'https://wustl.wd1.myworkdayjobs.com/en-US/external' },
  { name: 'Boston Medical Center',   ats: 'workday', token: 'bmc',
    url: 'https://bmc.wd1.myworkdayjobs.com/en-US/BMC' },
  { name: 'CVS Health',              ats: 'workday', token: 'cvshealth',
    url: 'https://cvshealth.wd1.myworkdayjobs.com/en-US/cvs_health_careers' },
  { name: 'Enloe Health',            ats: 'workday', token: 'enloe',
    url: 'https://enloe.wd12.myworkdayjobs.com/en-US/EnloeHealth' },
  { name: 'Jupiter Medical Center',  ats: 'workday', token: 'jupitermed',
    url: 'https://jupitermed.wd1.myworkdayjobs.com/en-US/external' },

  // ── Health systems — iCIMS ────────────────────────────────────────────────
  { name: 'Dignity Health',          ats: 'icims', token: 'dignityhealth',
    url: 'https://careers-dignityhealth.icims.com/jobs/search?in_iframe=1' },
  { name: 'Tenet Healthcare',        ats: 'icims', token: 'tenethealth',
    url: 'https://careers-tenethealth.icims.com/jobs/search?in_iframe=1' },
  { name: 'HCA Healthcare',          ats: 'icims', token: 'hca',
    url: 'https://careers-hca.icims.com/jobs/search?in_iframe=1' },

  // ── Health systems — SAP SuccessFactors ───────────────────────────────────
  { name: 'Baylor Scott & White',    ats: 'successfactors', token: 'bswh',
    url: 'https://career4.successfactors.com/career?company=bswh&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Providence Health',       ats: 'successfactors', token: 'providence',
    url: 'https://career4.successfactors.com/career?company=providence&career_ns=job_listing_summary&resultType=XML' },

  // ── Health systems — Oracle Taleo ─────────────────────────────────────────
  { name: 'UAB Medicine',            ats: 'taleo', token: 'uab',
    url: 'https://uab.taleo.net/careersection/ext/jobsearch.ftl' },
  { name: 'Indiana University Health', ats: 'taleo', token: 'iuhealth',
    url: 'https://iuhealth.taleo.net/careersection/2/jobsearch.ftl' },
];
