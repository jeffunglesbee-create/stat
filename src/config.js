/**
 * STAT — Configuration v3.0
 * Time-aware polling schedule + expanded company seed list.
 * All user-editable settings live here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// KEYWORD WATCH GROUPS
// Evaluated top-to-bottom. First matching group determines priority.
// P1 = Pushover HIGH (siren, bypasses DnD)
// P2 = Pushover normal
// P3 = Email only
// ─────────────────────────────────────────────────────────────────────────────
export const WATCH_GROUPS = [
  // ── Epic at a hospital / health system (P1) ───────────────────────────────
  {
    priority: 1,
    label: 'Epic · Health System',
    keywords: [
      'epic', 'epic analyst', 'epic ambulatory', 'epiccare', 'epic application analyst',
      'epic build', 'epic implementation', 'ehr analyst', 'ehr application analyst',
      'clarity sql', 'clinical informatics analyst', 'healthcare it analyst',
      'health informatics analyst', 'epic inpatient', 'epic cadence',
      'epic resolute', 'epic beacon', 'epic radiant', 'epic willow',
      'epic optime', 'epic stork', 'epic clindoc', 'epic orders',
      // Cardiology / Cupid module — high-volume Epic install base, remote-friendly
      'epic cupid', 'epic cardiology', 'cardiac analyst',
      // HIM / Health Information Management — large remote workforce
      'epic him', 'health information management analyst', 'him analyst',
      // Identity / MPI — in demand at health system mergers and consolidations
      'epic identity', 'patient identity analyst', 'mpi analyst',

      // ── CERTIFICATION OPPORTUNITY SIGNALS ──────────────────────────────
      // "within Epic" is the key phrase — health systems actively building
      // their Epic footprint use this in descriptions. These roles almost
      // always include certification sponsorship ($1,000–$3,000/module).
      // Reversed because descriptions say "work within Epic" not "epic within".
      'within epic',           // "experience within Epic", "work within Epic"
      'epic within',           // "Epic within 6 months"
      'within the epic',       // "within the Epic environment"
      'epic ecosystem',        // "within the Epic ecosystem"
      'epic certification',    // "opportunity to earn Epic certification"
      'epic certified',        // "become Epic certified"
      'epic training',         // "Epic training provided"
      'sponsored certification', // explicit sponsorship language
      'certification opportunity', // "certification opportunities available"
      'earn certification',    // "earn your Epic certification"
      'become certified',      // "become certified in Epic"

      // Go-live signals — active implementations = cert opportunity
      'epic go-live', 'epic go live', 'ehr go-live',
      'epic optimization',     // optimization projects require deeper cert
      'epic upgrade',          // upgrade projects = cert renewal opportunities
    ],
    companyFilter: {
      health_system_hints: [
        'health', 'hospital', 'medical center', 'medical centre', 'clinic',
        'healthcare', 'medicine', 'physician', 'care center', 'care centre',
        'health system', 'health network', 'health plan', 'health sciences',
        'memorial', 'baptist', 'presbyterian', 'methodist', 'adventist',
        'ascension', 'dignity', 'intermountain', 'providence', 'kaiser',
        'ucsf', 'mayo', 'geisinger', 'sanford', 'vanderbilt', 'atrium',
      ],
      consulting_hints: [
        'consulting', 'consultancy', 'advisors', 'advisory', 'solutions',
        'partners', 'staffing', 'technology', 'technologies', 'services',
        'implement', 'accenture', 'deloitte', 'cognizant', 'optum', 'leidos',
        'nordic', 'guidehouse', 'huron', 'chartis', 'netsmart', 'tegria',
        'divurgent', 'inovalon', 'evolent',
      ],
    },
  },

  // ── Certification Opportunity — description-level signal ─────────────────
  // These roles explicitly mention Epic certification, sponsorship, or active
  // implementations. Employer paying $1,000–$3,000/module = career accelerant.
  // Separate group so UI shows distinct "🎓 Cert Opportunity" label.
  {
    priority: 1,
    label: '🎓 Cert Opportunity',
    keywords: [
      'will be certified', 'training to become', 'certification provided',
      'epic certification included', 'certification upon completion',
      'epic certification preferred', 'certification reimbursement',
      'professional development epic', 'epic training included',
    ],
  },

  // ── Epic at a consulting firm (P2 default, fit-upgrades to P1) ───────────
  {
    priority: 2,
    label: 'Epic · Consulting (fit-gated)',
    keywords: [
      'epic consultant', 'ehr consultant', 'health it consultant',
      'healthcare it consultant', 'epic contractor', 'epic contract',
      'traveling epic', 'remote epic consultant',
    ],
  },

  // ── Remote Customer Service (P1) ─────────────────────────────────────────
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

  // ── Logistics & Supply Chain (P1) ────────────────────────────────────────
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

  // ── Data / Analytics (P2) ────────────────────────────────────────────────
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

  // ── Product / Project / IT (P3) ──────────────────────────────────────────
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
// GHOST JOB THRESHOLDS
// ─────────────────────────────────────────────────────────────────────────────
export const GHOST = {
  warn_after_days: 21,
  suppress_after_days: 90,
};

// ─────────────────────────────────────────────────────────────────────────────
// TIME-AWARE POLL SCHEDULE (US Eastern Time)
//
// 4x multiplier vs original — cuts alarm writes ~75%, enabling ~3,300 companies
// at $25/month while preserving competitive speed during peak windows.
//
// Research basis:
//   - Tuesday peak posting day (22% of weekly postings — ZipRecruiter 10M jobs)
//   - 6-10am ET prime window (89% more responses vs after 4pm — TalentWorks)
//   - Applying within 48hrs = 21% response rate vs 8% after 14 days (OpteroAI)
//   - Weekends/overnight: near-zero new postings, jobs sit until Monday
//
// Windows (ET → interval):
//   Mon–Fri 6am–10am  : 2min   peak posting + recruiter review
//   Mon–Fri 10am–4pm  : 4min   active business hours
//   Mon–Fri 4pm–7pm   : 8min   declining activity
//   Mon–Fri 7pm–6am   : 20min  overnight dead zone
//   Saturday          : 20min  minimal activity
//   Sunday 6am–4pm    : 8min   light activity
//   Sunday 4pm–midnight: 4min  Monday pre-posts go live Sunday evening
// ─────────────────────────────────────────────────────────────────────────────
export function getPollingInterval(ats) {
  const nowET = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  const day  = nowET.getDay();   // 0=Sun, 1=Mon … 6=Sat
  const hour = nowET.getHours(); // 0–23

  let windowMs;

  if (day === 6) {
    windowMs = 20 * 60_000;                          // Saturday
  } else if (day === 0) {
    if (hour >= 16)      windowMs = 4  * 60_000;     // Sun 4pm–midnight
    else if (hour >= 6)  windowMs = 8  * 60_000;     // Sun 6am–4pm
    else                 windowMs = 20 * 60_000;     // Sun midnight–6am
  } else {
    if (hour >= 6  && hour < 10) windowMs = 2  * 60_000; // Mon–Fri 6–10am ★
    else if (hour >= 10 && hour < 16) windowMs = 4  * 60_000; // 10am–4pm
    else if (hour >= 16 && hour < 19) windowMs = 8  * 60_000; // 4–7pm
    else                              windowMs = 20 * 60_000;  // 7pm–6am
  }

  // ATS-specific floors — never poll fragile ATS faster than they can handle
  const floors = {
    greenhouse:     2 * 60_000,
    lever:          2 * 60_000,
    ashby:          2 * 60_000,
    workday:        3 * 60_000,  // 3min floor — 121 cos / 25 chunk = 14.5min sweep
    icims:          4 * 60_000,
    successfactors: 8 * 60_000,
    taleo:          8 * 60_000,
    oracle_hcm:     8 * 60_000,
    infor_hcm:      8 * 60_000,
    selectminds:    8 * 60_000,  // ID range walk — 60 IDs/cycle, polite 150ms delay
  };
  return Math.max(windowMs, floors[ats] ?? 4 * 60_000);
}

// Per-platform chunk sizes — companies polled per alarm cycle.
// Workday is the largest platform (121 cos) and benefits most from a larger chunk.
// CPU budget: 30s wall-clock. At 150ms inter-company delay + ~500ms avg fetch:
//   chunk=15 → ~9.75s | chunk=20 → ~13s | chunk=25 → ~16.25s
// All are well within 30s. Workday at 25: 121/25 × 180s = 14.5min full sweep.
export const CHUNK_SIZES = {
  greenhouse:     15,
  lever:          15,
  ashby:          15,
  workday:        25,  // 121 companies; 25 × 180s = 14.5min worst-case alert latency
  icims:          15,
  successfactors: 15,
  taleo:          15,
  oracle_hcm:     15,
  infor_hcm:      15,
  selectminds:     1,  // ID-walk adapter — 1 company per cycle by design
};

// Legacy static intervals — used only by HiringCafe cron (not DO-based)
export const POLL_INTERVALS = { hiringcafe: 60_000 };

// ─────────────────────────────────────────────────────────────────────────────
// KV KEYS
// ─────────────────────────────────────────────────────────────────────────────
export const KV = {
  seen_jobs:      'stat:seen_job_ids',
  company_list:   'stat:company_watchlist',
  do_registry:    'stat:do_registry',
  match_counts:   'stat:match_counts',
  resume_profile: 'stat:resume_profile',
  batch_watchlist:'stat:batch_watchlist',   // companies polled by BatchPollerDO
  max_seen:       5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// RESUME FIT SCORING
// ─────────────────────────────────────────────────────────────────────────────
export const FIT_SCORING = {
  enabled:           true,
  min_score_for_push: 6,
  min_score_for_p1:   7,
  model: 'gemini-2.5-flash-lite',  // free tier: 1500 RPD, 0 cost at STAT match rates,
};

// ─────────────────────────────────────────────────────────────────────────────
// COMPANY LEARNING & PROMOTION
// ─────────────────────────────────────────────────────────────────────────────
export const LEARNING = {
  promote_after_matches: 2,
  promote_window_ms: 30 * 24 * 60 * 60 * 1000,
};

// ─────────────────────────────────────────────────────────────────────────────
// HIRINGCAFE WIDE-NET SCRAPE
// ─────────────────────────────────────────────────────────────────────────────
export const HIRINGCAFE = {
  environments: ['remote', 'hybrid'],
  search_terms: [
    // Epic / EHR module-specific
    'epic analyst', 'epic ambulatory', 'ehr analyst',
    'clarity sql', 'healthcare it analyst',
    'epic reporting', 'epic cogito', 'epic caboodle',
    'epic within', 'epic cadence', 'epic mychart',
    'epic inpatient', 'epic optime', 'epic beacon',
    'epic radiant', 'epic willow', 'epic resolute',
    // Broader health IT
    'clinical informatics analyst', 'health informatics analyst',
    // Cardiology, HIM, Identity — modules in profile with no HiringCafe coverage
    'epic cupid', 'epic him', 'epic identity', 'him analyst',
    // Remote CS / contact center
    'remote customer service', 'remote customer success',
    'virtual customer support', 'work from home customer service',
    'remote contact center',
    // Logistics / supply chain
    'remote logistics coordinator', 'remote supply chain',
    'logistics analyst remote', 'remote freight coordinator',
    'remote operations coordinator',
    // Data / analytics
    'data analyst', 'remote business analyst',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// BATCH POLLER CONFIG
// Companies in BATCH_WATCHLIST are polled by a single BatchPollerDO on a
// rotating cycle — no alarm per company, flat cost regardless of list size.
// Freshness: one full cycle every ~5–8 minutes during business hours.
// Use for: general companies, logistics firms, CS employers — the long tail.
// ─────────────────────────────────────────────────────────────────────────────
export const BATCH_POLLER = {
  // Polite pacing between ATS fetches — Tier 2.5 companies, not fragile
  delay_between_fetches_ms: 200,   // was 400ms — batch companies are robust APIs
  // Max companies per alarm cycle — 25 × 200ms = 5s, well within 30s limit
  companies_per_cycle: 25,         // was 50 — safer with 200ms delay
  // Faster alarm interval for better coverage of the batch watchlist
  alarm_interval_ms: 2 * 60_000,  // was 4 min — 2 min covers list faster
};

// ─────────────────────────────────────────────────────────────────────────────
// SEED COMPANY WATCHLIST (Tier 1 — Direct DO polling)
// ~150 highest-priority employers. All ATS tokens verified from live career pages.
// For scale beyond ~750 companies, use BATCH_WATCHLIST below.
// ─────────────────────────────────────────────────────────────────────────────
export const SEED_COMPANIES = [

  // ── Epic consulting firms ─────────────────────────────────────────────────
  { name: 'Nordic Consulting',          ats: 'greenhouse', token: 'nordicglobal' , mdApproved: true},
  { name: 'Guidehouse',                 ats: 'greenhouse', token: 'guidehouse' , mdApproved: true},
  { name: 'Huron Consulting',           ats: 'greenhouse', token: 'huron' , mdApproved: true},
  { name: 'Impact Advisors',            ats: 'greenhouse', token: 'impactadvisors' , mdApproved: true},
  { name: 'Optimum Healthcare IT',      ats: 'greenhouse', token: 'optimumhealthcareit' },
  { name: 'Divurgent',                  ats: 'greenhouse', token: 'divurgent' },
  { name: 'Tegria',                     ats: 'greenhouse', token: 'tegria' },
  { name: 'Pivot Point Consulting',     ats: 'greenhouse', token: 'pivotpointconsulting' },
  { name: 'Leidos Health',              ats: 'greenhouse', token: 'leidos' , mdApproved: true},
  { name: 'Accenture',                  ats: 'greenhouse', token: 'accenture' , mdApproved: true},
  { name: 'Deloitte',                   ats: 'greenhouse', token: 'deloitte' , mdApproved: true},
  { name: 'Optum',                      ats: 'greenhouse', token: 'optum' , mdApproved: true},
  { name: 'Cognizant',                  ats: 'greenhouse', token: 'cognizant' , mdApproved: true},
  { name: 'Evolent Health',             ats: 'greenhouse', token: 'evolenthealth' },
  { name: 'Health Catalyst',            ats: 'greenhouse', token: 'healthcatalyst' },
  { name: 'Inovalon',                   ats: 'greenhouse', token: 'inovalon' },
  { name: 'Netsmart',                   ats: 'lever',      token: 'netsmart' },
  { name: 'Chartis Group',              ats: 'lever',      token: 'chartisgroup' },
  { name: 'S&P Consultants',            ats: 'lever',      token: 'spconsultants' },
  { name: 'Engage (Meditech)',          ats: 'ashby',      token: 'engage' },

  // ── Health systems — Workday (verified URLs from live career pages) ───────
  { name: 'Johns Hopkins',              ats: 'workday', token: 'jhhs',
    url: 'https://jhhs.wd5.myworkdayjobs.com/en-US/JHH_External_Positions', mdApproved: true },
  { name: 'Mayo Clinic',               ats: 'workday', token: 'mayoclinic',
    url: 'https://mayoclinic.wd5.myworkdayjobs.com/en-US/mayoclinic' },
  { name: 'Kaiser Permanente',         ats: 'workday', token: 'kaiserpermanente',
    url: 'https://kp.wd5.myworkdayjobs.com/en-US/KP_External_Career_Site' },
  { name: 'Cleveland Clinic',          ats: 'workday', token: 'clevelandclinic',
    url: 'https://jobs.clevelandclinic.org' }, // Custom domain — /wday/cxs/ API unavailable; SSR fallback path
  { name: 'Mass General Brigham',      ats: 'workday', token: 'massgeneralbrigham',
    url: 'https://massgeneralbrigham.wd1.myworkdayjobs.com/en-US/MGB_External', mdApproved: true },
  { name: 'Penn Medicine',             ats: 'workday', token: 'pennmedicine',
    url: 'https://uphs.wd5.myworkdayjobs.com/en-US/UPHS' },
  // UCSF Health: on Avature (careers.ucsf.edu) — verified 2026-06-06 via live probe.
  // NOT Workday, NOT BrassRing. STAT has no Avature adapter.
  // Covered by HiringCafe wide-net. Do not add to SEED_COMPANIES.
  { name: 'Vanderbilt Health',         ats: 'workday', token: 'vanderbilt',
    url: 'https://vanderbilt.wd5.myworkdayjobs.com/en-US/ext-vumc' },
  { name: 'AdventHealth',              ats: 'workday', token: 'adventhealth',
    url: 'https://adventhealth.wd1.myworkdayjobs.com/en-US/AdventHealthCareers' },
  { name: 'Ascension',                 ats: 'workday', token: 'ascension',
    url: 'https://ascension.wd1.myworkdayjobs.com/en-US/Ascension_Careers' },
  { name: 'CommonSpirit Health',       ats: 'workday', token: 'commonspirit',
    url: 'https://commonspirit.wd5.myworkdayjobs.com/en-US/CommonSpiritHealthExternal' },
  { name: 'Intermountain Health',      ats: 'workday', token: 'imh',
    url: 'https://imh.wd108.myworkdayjobs.com/IntermountainCareers' },
  { name: 'Advocate Health (Atrium)',   ats: 'workday', token: 'aah',
    url: 'https://aah.wd5.myworkdayjobs.com/External' },
  { name: 'Geisinger',                 ats: 'workday', token: 'geisinger',
    url: 'https://geisinger.wd5.myworkdayjobs.com/en-US/MyGeisingerCareers' },
  { name: 'Sanford Health',            ats: 'workday', token: 'sanfordhealth',
    url: 'https://sanfordhealth.wd5.myworkdayjobs.com/en-US/SanfordCareers' },
  { name: 'Houston Methodist',         ats: 'workday', token: 'houstonmethodist',
    url: 'https://houstonmethodist.wd12.myworkdayjobs.com/en-US/GTI' },
  { name: 'WashU Medicine',            ats: 'workday', token: 'washu',
    url: 'https://wustl.wd1.myworkdayjobs.com/en-US/external' },
  { name: 'Boston Medical Center',     ats: 'workday', token: 'bmc',
    url: 'https://bmc.wd1.myworkdayjobs.com/en-US/BMC' },
  { name: 'CVS Health',                ats: 'workday', token: 'cvshealth',
    url: 'https://cvshealth.wd1.myworkdayjobs.com/en-US/cvs_health_careers', mdApproved: true },
  { name: 'Enloe Health',              ats: 'workday', token: 'enloe',
    url: 'https://enloe.wd12.myworkdayjobs.com/en-US/EnloeHealth' },
  { name: 'Jupiter Medical Center',    ats: 'workday', token: 'jupitermed',
    url: 'https://jupitermed.wd1.myworkdayjobs.com/en-US/external' },
  { name: 'OU Health',                 ats: 'workday', token: 'ouhealth',
    url: 'https://oumedicine.wd5.myworkdayjobs.com/en-US/OUHealthCareers' },
  { name: 'Banner Health',             ats: 'workday', token: 'bannerhealth',
    url: 'https://bannerhealth.wd5.myworkdayjobs.com/Careers' },
  { name: 'Methodist Health System',   ats: 'workday', token: 'methodisthealthsystem',
    url: 'https://methodisthealthsystem.wd1.myworkdayjobs.com/MHS_Careers' },
  { name: 'VHC Health',                ats: 'workday', token: 'vhchealth',
    url: 'https://vhchealth.wd1.myworkdayjobs.com/en-US/VHCHealth', mdApproved: true },
  { name: 'MultiCare Health',          ats: 'workday', token: 'multicare',
    url: 'https://multicare.wd1.myworkdayjobs.com/multicare' },
  { name: 'St. Luke\'s UHNM',          ats: 'workday', token: 'sluhn',
    url: 'https://sluhn.wd1.myworkdayjobs.com/SLUHN' },
  { name: 'Brown University Health',   ats: 'workday', token: 'brownhealth',
    url: 'https://brownhealth.wd12.myworkdayjobs.com/External_Careers' },
  { name: 'WellStar Health',           ats: 'workday', token: 'wellstar',
    url: 'https://wellstar.wd5.myworkdayjobs.com/en-US/WellStarCareers' },
  { name: 'Northwell Health',          ats: 'icims', token: 'northwell',
    url: 'https://northwell.icims.com/jobs/search?in_iframe=1' },
  // NOTE: verify northwell.icims.com — job posted at jobs.northwell.edu (iCIMS custom domain)
  // If search returns 0 jobs, try: careers-northwell.icims.com
  { name: 'NYU Langone Health',        ats: 'workday', token: 'nyulangone',
    url: 'https://nyulangone.wd5.myworkdayjobs.com/en-US/Careers' },
  { name: 'UPMC',                      ats: 'taleo',   token: 'upmc',
    url: 'https://upmcjobs.taleo.net/careersection/UPMC_External/jobsearch.ftl' },
  { name: 'Ochsner Health',            ats: 'workday', token: 'ochsner',
    url: 'https://ochsner.wd5.myworkdayjobs.com/en-US/Ochsner' },
  { name: 'Prisma Health',             ats: 'workday', token: 'prismahealth',
    url: 'https://prismahealth.wd5.myworkdayjobs.com/en-US/PrismaHealthCareers' },
  { name: 'Piedmont Healthcare',       ats: 'workday', token: 'piedmont',
    url: 'https://piedmont.wd5.myworkdayjobs.com/en-US/PiedmontCareers' },
  { name: 'Spectrum Health / Corewell',ats: 'workday', token: 'corewellhealth',
    url: 'https://corewellhealth.wd5.myworkdayjobs.com/en-US/corewellexternal' },
  { name: 'Henry Ford Health',         ats: 'workday', token: 'henryfordhealth',
    url: 'https://henryfordhealth.wd5.myworkdayjobs.com/en-US/Henry_Ford_Health' },
  { name: 'Cedars-Sinai',              ats: 'workday', token: 'cedarssinai',
    url: 'https://cedars-sinai.wd5.myworkdayjobs.com/en-US/CS_Careers' },
  { name: 'Christus Health',           ats: 'workday', token: 'christus',
    url: 'https://christus.wd5.myworkdayjobs.com/en-US/CHRISTUS' },
  { name: 'Hackensack Meridian',       ats: 'workday', token: 'hackensackmeridian',
    url: 'https://hackensackmeridian.wd5.myworkdayjobs.com/en-US/HMH' },
  { name: 'RWJBarnabas Health',        ats: 'workday', token: 'rwjbarnabas',
    url: 'https://rwjbarnabas.wd5.myworkdayjobs.com/en-US/external_career_site' },
  { name: 'Duke Health',               ats: 'workday', token: 'dukehealth',
    url: 'https://dukehealth.wd5.myworkdayjobs.com/en-US/Duke' },
  { name: 'UNC Health',                ats: 'workday', token: 'unchealth',
    url: 'https://unchealth.wd5.myworkdayjobs.com/en-US/UNC_Health' },
  { name: 'OSF HealthCare',            ats: 'workday', token: 'osf',
    url: 'https://osf.wd5.myworkdayjobs.com/en-US/OSF' },
  { name: 'Adventist Health',          ats: 'workday', token: 'adventisthealth',
    url: 'https://adventisthealth.wd5.myworkdayjobs.com/en-US/AdventistHealthCareers' },
  { name: 'Mercy Health',              ats: 'workday', token: 'mercy',
    url: 'https://mercy.wd5.myworkdayjobs.com/en-US/MercyCareers' },
  { name: 'Trinity Health',            ats: 'workday', token: 'trinity',
    url: 'https://trinity.wd5.myworkdayjobs.com/en-US/TrinityHealthCareers' },
  { name: 'Sutter Health',             ats: 'workday', token: 'sutterhealth',
    url: 'https://sutterhealth.wd5.myworkdayjobs.com/en-US/SutterHealthCareers' },
  { name: 'Children\'s Hospital of Philadelphia', ats: 'workday', token: 'chop',
    url: 'https://chop.wd5.myworkdayjobs.com/en-US/CHOP_Careers' },
  { name: 'Seattle Children\'s',       ats: 'workday', token: 'seattlechildrens',
    url: 'https://seattlechildrens.wd5.myworkdayjobs.com/en-US/careers' },
  { name: 'Children\'s National',      ats: 'workday', token: 'childrensnational',
    url: 'https://childrensnational.wd5.myworkdayjobs.com/en-US/CNH' },
  { name: 'Stanford Health Care',      ats: 'workday', token: 'stanfordhealthcare',
    url: 'https://stanfordhealthcare.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'OHSU',                      ats: 'workday', token: 'ohsu',
    url: 'https://ohsu.wd5.myworkdayjobs.com/en-US/Careers' },
  { name: 'UW Medicine',               ats: 'workday', token: 'uwmedicine',
    url: 'https://uwmedicine.wd5.myworkdayjobs.com/en-US/UWMed_External' },
  { name: 'University of Michigan Health', ats: 'workday', token: 'uofmhealth',
    url: 'https://uofmhealth.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'UChicago Medicine',         ats: 'workday', token: 'uchicagomed',
    url: 'https://uchicagomed.wd5.myworkdayjobs.com/en-US/UChicagoMedCareers' },
  { name: 'Rush University Medical',   ats: 'workday', token: 'rush',
    url: 'https://rush.wd5.myworkdayjobs.com/en-US/RushCareers' },

  { name: 'Stanford Health Care',        ats: 'workday', token: 'stanfordmedicine',
    url: 'https://stanfordmedicine.wd115.myworkdayjobs.com/en-US/shc_external_career_site' },
  // Confirmed 2026-06-08: wd115 tenant, shc_external_career_site board

  // ── Health systems — iCIMS ────────────────────────────────────────────────
  // Verified live tenants (Session Part 1, 2026-06-06):
  //   VHC Health: plain fetch + ?in_iframe=1 confirmed → 8 jobs, 423ms, not blocked
  //   UCI Health: confirmed live (verify with /plain-fetch-test before querying)
  //   Infirmary Health: confirmed live
  //   PHS: confirmed live
  // Confirmed MIGRATED AWAY from iCIMS (Session Part 1):
  //   HCA → Oracle Taleo (hca.taleo.net)
  //   Dignity Health → migrated
  //   Encompass Health → migrated
  //   Tenet Healthcare → Oracle Fusion Cloud HCM (eodr.fa.us2.oraclecloud.com)
  { name: 'VHC Health',                ats: 'icims', token: 'vhchealth',
    url: 'https://careers-vhchealth.icims.com/jobs/search?in_iframe=1' },
  { name: 'UCI Health',                ats: 'icims', token: 'uci',
    url: 'https://careers-uci.icims.com/jobs/search?in_iframe=1' },
  { name: 'Infirmary Health',          ats: 'icims', token: 'infirmaryhealth',
    url: 'https://careers-infirmaryhealth.icims.com/jobs/search?in_iframe=1' },
  { name: 'PHS',                       ats: 'icims', token: 'phs',
    url: 'https://careers-phs.icims.com/jobs/search?in_iframe=1' },
  { name: 'Lifepoint Health',          ats: 'icims', token: 'lifepointhealth',
    url: 'https://careers-lifepointhealth.icims.com/jobs/search?in_iframe=1' },
  { name: 'Community Health Systems',  ats: 'icims', token: 'chs',
    url: 'https://careers-chs.icims.com/jobs/search?in_iframe=1' },

  // ── Health systems — SAP SuccessFactors ───────────────────────────────────
  // XML feed confirmed working 2026-06-06. Full job description in <Job-Description> CDATA.
  // No second-pass fetch needed — description available at list level.
  { name: 'Johns Hopkins Health System', ats: 'successfactors', token: 'SFHUP',
    url: 'https://career4.successfactors.com/career?company=SFHUP&career_ns=job_listing_summary&resultType=XML', mdApproved: true },
  { name: 'Baylor Scott & White',      ats: 'successfactors', token: 'bswh',
    url: 'https://career4.successfactors.com/career?company=bswh&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Providence Health',         ats: 'successfactors', token: 'providence',
    url: 'https://career4.successfactors.com/career?company=providence&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Allina Health',             ats: 'successfactors', token: 'allina',
    url: 'https://career4.successfactors.com/career?company=allina&career_ns=job_listing_summary&resultType=XML' },
  { name: 'SCL Health / Intermountain', ats: 'successfactors', token: 'sclhealth',
    url: 'https://career4.successfactors.com/career?company=sclhealth&career_ns=job_listing_summary&resultType=XML' },
  // ── SuccessFactors additions (2026-06-08) ─────────────────────────────────
  // All use career4.successfactors.com XML feed — descriptions in <Job-Description>
  // CDATA, no second-pass fetch needed. Token wrong → empty feed, no harm.
  // Entries marked VERIFY: token uncertain, may be on different ATS.
  { name: 'Mercy Health',               ats: 'successfactors', token: 'mercy',
    url: 'https://career4.successfactors.com/career?company=mercy&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Sentara Health',             ats: 'successfactors', token: 'sentara',
    url: 'https://career4.successfactors.com/career?company=sentara&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Hackensack Meridian Health', ats: 'successfactors', token: 'hmhn',
    url: 'https://career4.successfactors.com/career?company=hmhn&career_ns=job_listing_summary&resultType=XML' },
  { name: 'WakeMed',                    ats: 'successfactors', token: 'wakemed',
    url: 'https://career4.successfactors.com/career?company=wakemed&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Trinity Health',             ats: 'successfactors', token: 'trinityhealth',
    url: 'https://career4.successfactors.com/career?company=trinityhealth&career_ns=job_listing_summary&resultType=XML' },
  { name: 'MultiCare Health System',    ats: 'successfactors', token: 'multicare',
    url: 'https://career4.successfactors.com/career?company=multicare&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Sanford Health',             ats: 'successfactors', token: 'sanfordhealth',
    url: 'https://career4.successfactors.com/career?company=sanfordhealth&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Corewell Health',            ats: 'successfactors', token: 'corewell',
    url: 'https://career4.successfactors.com/career?company=corewell&career_ns=job_listing_summary&resultType=XML' },
  { name: 'MemorialCare',               ats: 'successfactors', token: 'memorialcare',
    url: 'https://career4.successfactors.com/career?company=memorialcare&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Sutter Health',              ats: 'successfactors', token: 'sutter',
    url: 'https://career4.successfactors.com/career?company=sutter&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Centura Health',             ats: 'successfactors', token: 'centura',
    url: 'https://career4.successfactors.com/career?company=centura&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Baptist Health South Florida', ats: 'successfactors', token: 'baptisthealth',
    url: 'https://career4.successfactors.com/career?company=baptisthealth&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Ochsner Health',             ats: 'successfactors', token: 'ochsner',
    url: 'https://career4.successfactors.com/career?company=ochsner&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Inova Health System',        ats: 'successfactors', token: 'inova',
    url: 'https://career4.successfactors.com/career?company=inova&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Piedmont Healthcare',        ats: 'successfactors', token: 'piedmont',
    url: 'https://career4.successfactors.com/career?company=piedmont&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Ballad Health',              ats: 'successfactors', token: 'balladhealth',
    url: 'https://career4.successfactors.com/career?company=balladhealth&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Children\'s Hospital Colorado', ats: 'successfactors', token: 'chco',
    url: 'https://career4.successfactors.com/career?company=chco&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Essentia Health',            ats: 'successfactors', token: 'essentia',
    url: 'https://career4.successfactors.com/career?company=essentia&career_ns=job_listing_summary&resultType=XML' },
  { name: 'UnityPoint Health',          ats: 'successfactors', token: 'unitypoint',
    url: 'https://career4.successfactors.com/career?company=unitypoint&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Carilion Clinic',            ats: 'successfactors', token: 'carilion',
    url: 'https://career4.successfactors.com/career?company=carilion&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Memorial Hermann',           ats: 'successfactors', token: 'memorialhermann',
    url: 'https://career4.successfactors.com/career?company=memorialhermann&career_ns=job_listing_summary&resultType=XML' },
  { name: 'Aultman Health Foundation',  ats: 'successfactors', token: 'aultman',
    url: 'https://career4.successfactors.com/career?company=aultman&career_ns=job_listing_summary&resultType=XML' },
  { name: 'OhioHealth',                 ats: 'successfactors', token: 'ohiohealth',
    url: 'https://career4.successfactors.com/career?company=ohiohealth&career_ns=job_listing_summary&resultType=XML' },

  // ── Health systems — Oracle Taleo ─────────────────────────────────────────
  { name: 'UAB Medicine',              ats: 'taleo', token: 'uab',
    url: 'https://uab.taleo.net/careersection/ext/jobsearch.ftl' },
  { name: 'Indiana University Health', ats: 'taleo', token: 'iuhealth',
    url: 'https://iuhealth.taleo.net/careersection/2/jobsearch.ftl' },
  { name: 'Froedtert Health',          ats: 'taleo', token: 'froedtert',
    url: 'https://froedtert.taleo.net/careersection/2/jobsearch.ftl' },
  { name: 'Fairview Health Services',  ats: 'taleo', token: 'fairview',
    url: 'https://fairview.taleo.net/careersection/2/jobsearch.ftl' },

  // ── Health systems — SelectMinds (Oracle Taleo Social Sourcing) ───────────
  // SelectMinds is Taleo's social referral layer. Ember SPA with fully SSR'd
  // detail pages. Discovery via sequential ID walk (plain fetch, no auth).
  // token = string of the starting SelectMinds job ID for the scan window.
  // Update token after each confirmed live high-water mark to slide the window.
  // Confirmed 2026-06-08: 700+ jobs live, Epic roles in IT category (~33 jobs).
  { name: 'UTMB Health',               ats: 'selectminds', token: '1000',
    url: 'https://aa083s01.upgrade.selectminds.com/utmb' },
  // University of Texas Medical Branch. Galveston TX. ~13K employees.
  // Epic shop confirmed by job title: "Lead Clinical Application Systems Analyst - Epic (90% remote)".
  // Backend: Taleo (Job.taleo_job_number exposed in hidden inputs).
  { name: 'Concentrix',                ats: 'workday', token: 'concentrix',
    url: 'https://concentrix.wd5.myworkdayjobs.com/en-US/External', mdApproved: true },
  { name: 'TTEC',                      ats: 'workday', token: 'ttec',
    url: 'https://ttec.wd5.myworkdayjobs.com/en-US/External', mdApproved: true },
  { name: 'Teleperformance',           ats: 'workday', token: 'teleperformance',
    url: 'https://teleperformance.wd3.myworkdayjobs.com/en-US/TPglobal' },
  { name: 'Foundever (Sitel)',         ats: 'workday', token: 'foundever',
    url: 'https://foundever.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Conduent',                  ats: 'workday', token: 'conduent',
    url: 'https://conduent.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Transcom',                  ats: 'greenhouse', token: 'transcom' },
  { name: 'ModSquad',                  ats: 'greenhouse', token: 'modsquad' },
  { name: 'Working Solutions',         ats: 'greenhouse', token: 'workingsolutions' },
  { name: 'Alorica',                   ats: 'workday', token: 'alorica',
    url: 'https://alorica.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'TaskUs',                    ats: 'greenhouse', token: 'taskus' },
  { name: 'Ibex Global',               ats: 'greenhouse', token: 'ibex' },
  { name: 'Arise Virtual Solutions',   ats: 'greenhouse', token: 'arise' },
  { name: 'NexRep',                    ats: 'greenhouse', token: 'nexrep' },
  { name: 'LiveOps',                   ats: 'greenhouse', token: 'liveops' },
  { name: 'Liveops Cloud',             ats: 'lever',      token: 'liveopscloud' },
  { name: 'Sutherland Global',         ats: 'workday', token: 'sutherland',
    url: 'https://sutherland.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Maximus',                   ats: 'workday', token: 'maximus',
    url: 'https://maximus.wd5.myworkdayjobs.com/en-US/External', mdApproved: true },
  { name: 'Sykes (Sitel)',             ats: 'workday', token: 'sykes',
    url: 'https://sykes.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Qualfon',                   ats: 'greenhouse', token: 'qualfon' },
  { name: 'Aux (AuxBot)',              ats: 'ashby',      token: 'aux' },

  // ── Logistics & supply chain employers ────────────────────────────────────
  { name: 'XPO Logistics',             ats: 'workday', token: 'xpo',
    url: 'https://xpo.wd5.myworkdayjobs.com/en-US/xpocareers' },
  { name: 'Echo Global Logistics',     ats: 'greenhouse', token: 'echogloballogistics' },
  { name: 'Flexport',                  ats: 'greenhouse', token: 'flexport' },
  { name: 'Convoy',                    ats: 'greenhouse', token: 'convoy' },
  { name: 'Transfix',                  ats: 'greenhouse', token: 'transfix' },
  { name: 'Loadsmart',                 ats: 'greenhouse', token: 'loadsmart' },
  { name: 'project44',                 ats: 'greenhouse', token: 'project44' },
  { name: 'FourKites',                 ats: 'greenhouse', token: 'fourkites' },
  { name: 'Turvo',                     ats: 'greenhouse', token: 'turvo' },
  { name: 'Nuvolo',                    ats: 'lever',      token: 'nuvolo' },
  { name: 'MoLo Solutions',            ats: 'lever',      token: 'molosolutions' },
  { name: 'GlobalTranz',               ats: 'lever',      token: 'globaltranz' },
  { name: 'Uber Freight',              ats: 'greenhouse', token: 'uberfreight' },
  { name: 'Coyote Logistics',          ats: 'greenhouse', token: 'coyotelogistics' },
  { name: 'Arrive Logistics',          ats: 'greenhouse', token: 'arrivelogistics' },
  { name: 'MercuryGate',               ats: 'greenhouse', token: 'mercurygate' },
  { name: 'Shipwell',                  ats: 'greenhouse', token: 'shipwell' },
  { name: 'Stord',                     ats: 'ashby',      token: 'stord' },
  { name: 'Shipbob',                   ats: 'greenhouse', token: 'shipbob' },
  { name: 'Ware2Go (UPS)',             ats: 'greenhouse', token: 'ware2go' },
  { name: 'Flexe',                     ats: 'greenhouse', token: 'flexe' },
  { name: 'Capacity LLC',              ats: 'lever',      token: 'capacityllc' },
  { name: 'ArcBest',                   ats: 'workday', token: 'arcbest',
    url: 'https://arcbest.wd5.myworkdayjobs.com/en-US/Careers' },
  { name: 'Radiant Logistics',         ats: 'greenhouse', token: 'radiantlogistics' },
  { name: 'Forager',                   ats: 'lever',      token: 'forager' },
  { name: 'Next Trucking',             ats: 'greenhouse', token: 'nexttrucking' },
  { name: 'Rebus',                     ats: 'ashby',      token: 'rebus' },
  { name: 'Samsara',                   ats: 'greenhouse', token: 'samsara' },
  { name: 'KeepTruckin / Motive',      ats: 'greenhouse', token: 'keeptruckin' },
  { name: 'Platform Science',          ats: 'greenhouse', token: 'platformscience' },

  // ── Added 2026-06-06: research-based expansion ──────────────────────────────
  { name: 'ALKU', ats: 'greenhouse', token: 'alku' },
  { name: 'HealthTECH Resources', ats: 'greenhouse', token: 'healthtechresources' },
  { name: 'Ensemble Health Partners', ats: 'greenhouse', token: 'ensemblehp' },
  { name: 'CitiusTech', ats: 'greenhouse', token: 'citiustech' },
  { name: 'Premise Health', ats: 'greenhouse', token: 'premisehealth' },
  { name: 'Commure', ats: 'greenhouse', token: 'commure' },
  { name: 'Freed Associates', ats: 'greenhouse', token: 'freedassociates' },
  { name: 'Rightpoint', ats: 'greenhouse', token: 'rightpoint' },
  { name: 'Navin Haffty', ats: 'greenhouse', token: 'navinhaffty' },
  { name: 'Hayes Management', ats: 'greenhouse', token: 'hayesmanagement' },
  { name: 'Mazik Global', ats: 'greenhouse', token: 'mazikglobal' },
  { name: 'GeBBS Healthcare', ats: 'greenhouse', token: 'gebbs' },
  { name: 'VXI Global Solutions', ats: 'greenhouse', token: 'vxi' },
  { name: 'Berkeley Research Group', ats: 'lever', token: 'brg' },
  { name: 'Nference', ats: 'lever', token: 'nference' },
  { name: 'Sagility', ats: 'workday', url: 'https://sagility.wd1.myworkdayjobs.com/SagilityHealth' },
  { name: 'Atos Health', ats: 'workday', url: 'https://atos.wd3.myworkdayjobs.com/Atos_Careers' },
  { name: 'Maximus Federal', ats: 'workday', url: 'https://maximus.wd1.myworkdayjobs.com/Maximus_Careers' },
  { name: 'Medline Industries', ats: 'workday', url: 'https://medline.wd5.myworkdayjobs.com/medline' },
  { name: 'WellSpan Health', ats: 'workday', url: 'https://wellspan.wd5.myworkdayjobs.com/WellSpan' },
  { name: 'Bon Secours Mercy Health', ats: 'workday', url: 'https://bsmhealth.wd5.myworkdayjobs.com/BSMHCareers' },
  { name: 'Ballad Health', ats: 'workday', url: 'https://balladhealth.wd5.myworkdayjobs.com/Careers' },
  { name: 'Parkview Health', ats: 'workday', url: 'https://parkview.wd5.myworkdayjobs.com/Parkview_Careers' },
  { name: 'CoxHealth', ats: 'workday', url: 'https://coxhealth.wd5.myworkdayjobs.com/CoxHealth_Careers' },
  { name: 'Kettering Health', ats: 'workday', url: 'https://ketteringhealth.wd5.myworkdayjobs.com/KetteringHealth' },
  { name: 'Baptist Health South Florida', ats: 'workday', url: 'https://baptisthealth.wd5.myworkdayjobs.com/Careers' },
  { name: 'Sentara Health', ats: 'workday', url: 'https://sentara.wd5.myworkdayjobs.com/Sentara' },
  { name: 'OhioHealth', ats: 'workday', url: 'https://ohiohealth.wd5.myworkdayjobs.com/OhioHealth_External' },
  { name: 'Luminis Health', ats: 'workday', url: 'https://luminishealth.wd5.myworkdayjobs.com/LuminisHealth' },
  { name: 'Summa Health', ats: 'workday', url: 'https://summahealth.wd5.myworkdayjobs.com/External' },
  { name: 'UnityPoint Health', ats: 'workday', url: 'https://unitypoint.wd5.myworkdayjobs.com/UnityPoint_Careers' },
  { name: 'Aultman Health', ats: 'workday', url: 'https://aultman.wd5.myworkdayjobs.com/Aultman' },
  { name: 'Guthrie Health', ats: 'workday', url: 'https://guthrie.wd5.myworkdayjobs.com/GuthrieHealth' },
  { name: 'Aspirus Health', ats: 'workday', url: 'https://aspirus.wd5.myworkdayjobs.com/Aspirus' },
  { name: 'Parallon', ats: 'workday', url: 'https://hca.wd5.myworkdayjobs.com/HCAhealthcare' },
  { name: 'ResultsCX', ats: 'workday', url: 'https://resultscx.wd5.myworkdayjobs.com/External' },
  { name: 'Startek', ats: 'workday', url: 'https://startek.wd5.myworkdayjobs.com/StarTek' },
  { name: 'iQor', ats: 'workday', url: 'https://iqor.wd5.myworkdayjobs.com/iQor' },
  { name: 'Webhelp', ats: 'workday', url: 'https://webhelp.wd3.myworkdayjobs.com/Webhelp' },
  // ── Health systems — Oracle HCM (Fusion Cloud) ────────────────────────────
  // Oracle JET SPA. Description pre-rendered for SEO in HTML.
  // Confirmed 2026-06-08: class="job-details__description-content" contains full JD.
  // Salary pre-rendered: Minimum/Maximum Salary fields in body text.
  // Search URL: .../requisitions?keyword=epic
  // Job detail URL: .../job/{jobId}
  //
  // Known tenants:
  //   Cedars-Sinai:     hdkk.fa.us6.oraclecloud.com  site CX_2001
  //   Tenet Healthcare: eodr.fa.us2.oraclecloud.com  site TBD (verify with live job URL)
  { name: 'Cedars-Sinai',              ats: 'oracle_hcm', token: 'cedars-sinai',
    url: 'https://hdkk.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001/requisitions?keyword=epic' },
  // Tenet Healthcare — Oracle HCM tenant eodr us2 (confirmed migrated from Taleo)
  // Site ID needed — find a live job URL to extract siteId, then add:
  // { name: 'Tenet Healthcare', ats: 'oracle_hcm', token: 'tenet',
  //   url: 'https://eodr.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/{SITE_ID}/requisitions?keyword=epic' },

  // ── Health systems — Infor CloudSuite HCM ────────────────────────────────
  // Infor Lawson successor. Angular SPA. Description pre-rendered for SEO.
  // Salary often posted as hourly rate — converted × 2080 to annual.
  // Confirmed 2026-06-08: class="lm-richtext-content _op_PositionDescription" 
  // URL pattern: css-{slug}-prd.inforcloudsuite.com
  // Job search: /hcm/Jobs/form/JobPosting[JobPostingSet].JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000
  //
  // NOTE: Tenant slugs for all entries except Lee Health are inferred from
  // public career page URLs. Verify on first poll — if 0 jobs returned,
  // the slug may differ (e.g. chsli vs catholichealth-li).
  { name: 'Lee Health',                ats: 'infor_hcm', token: 'leememorial',
    url: 'https://css-leememorial-prd.inforcloudsuite.com/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000' },
  // Confirmed 2026-06-08 from HTML. Lee Memorial Health System, Fort Myers FL. Epic Cadence verified.

  { name: 'Catholic Health (NY)',       ats: 'infor_hcm', token: 'chsli',
    url: 'https://css-chsli-prd.inforcloudsuite.com/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000' },
  // Catholic Health Services of Long Island. Infor HCM. ~16K employees.

  { name: 'Lifespan',                   ats: 'infor_hcm', token: 'lifespan',
    url: 'https://css-lifespan-prd.inforcloudsuite.com/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000' },
  // Rhode Island health system (Brown University Health). Not in seed list.

  { name: 'Luminis Health',             ats: 'infor_hcm', token: 'luminis',
    url: 'https://css-luminis-prd.inforcloudsuite.com/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000' },
  // Annapolis MD. Regional non-profit. Dark horse candidate — mid-size Epic shop.

  { name: 'Nuvance Health',             ats: 'infor_hcm', token: 'nuvance',
    url: 'https://css-nuvance-prd.inforcloudsuite.com/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000' },
  // Hudson Valley NY/CT. ~8K employees. Epic shop.

  { name: 'WellSpan Health',            ats: 'infor_hcm', token: 'wellspan',
    url: 'https://css-wellspan-prd.inforcloudsuite.com/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000' },
  // South-central PA / northern MD. ~23K employees. Epic full suite.

  { name: 'Cone Health',                ats: 'infor_hcm', token: 'conehealth',
    url: 'https://css-conehealth-prd.inforcloudsuite.com/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000' },
  // Greensboro NC. ~13K employees. Epic Ambulatory roles observed on LinkedIn.

  { name: 'Samaritan Health Services',  ats: 'infor_hcm', token: 'samaritan',
    url: 'https://css-samaritan-prd.inforcloudsuite.com/hcm/Jobs/form/JobPosting%5BJobPostingSet%5D.JobSearch?csk.JobBoard=EXTERNAL&csk.HROrganization=1000' },
  // Corvallis OR. ~5K employees. Community health system, Epic shop.

];

// ─────────────────────────────────────────────────────────────────────────────
// BATCH WATCHLIST — Tier 2.5 (polled by BatchPollerDO, no alarm per company)
// Add companies here for 4-8min freshness at zero marginal cost per addition.
// The BatchPollerDO cycles through this list in chunks, one alarm does all.
// Ideal for: general US health systems, logistics long tail, CS employers.
// ─────────────────────────────────────────────────────────────────────────────
export const BATCH_WATCHLIST = [
  // Additional health systems — Workday
  { name: 'Novant Health',             ats: 'workday', token: 'novant',
    url: 'https://novant.wd5.myworkdayjobs.com/en-US/Novant_Health_External' },
  { name: 'Franciscan Health',         ats: 'workday', token: 'franciscanhealth',
    url: 'https://franciscanhealth.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Memorial Hermann',          ats: 'workday', token: 'memorialhermann',
    url: 'https://memorialhermann.wd5.myworkdayjobs.com/en-US/Memorial_Hermann_External' },
  { name: 'Tufts Medicine',            ats: 'workday', token: 'tuftsmedicine',
    url: 'https://tuftsmedicine.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'SSM Health',                ats: 'workday', token: 'ssmhealth',
    url: 'https://ssmhealth.wd5.myworkdayjobs.com/en-US/careers' },
  { name: 'Bon Secours Mercy',         ats: 'workday', token: 'bonsecours',
    url: 'https://bonsecours.wd5.myworkdayjobs.com/en-US/BSMH' },
  { name: 'Centura Health',            ats: 'workday', token: 'centura',
    url: 'https://centura.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Avera Health',              ats: 'workday', token: 'avera',
    url: 'https://avera.wd5.myworkdayjobs.com/en-US/AveraHealth' },
  { name: 'Essentia Health',           ats: 'workday', token: 'essentia',
    url: 'https://essentia.wd5.myworkdayjobs.com/en-US/EssentiaHealthCareers' },
  { name: 'CHRISTUS Health',           ats: 'workday', token: 'christushealth',
    url: 'https://christus.wd5.myworkdayjobs.com/en-US/CHRISTUS' },
  { name: 'WVU Medicine',              ats: 'workday', token: 'wvumedicine',
    url: 'https://wvumedicine.wd5.myworkdayjobs.com/en-US/external' },
  { name: 'UCHealth',                  ats: 'workday', token: 'uchealth',
    url: 'https://uchealth.wd5.myworkdayjobs.com/en-US/UCHealth' },
  { name: 'Stormont Vail',             ats: 'workday', token: 'stormontvail',
    url: 'https://stormontvail.wd5.myworkdayjobs.com/en-US/Careers' },
  { name: 'Cone Health',               ats: 'workday', token: 'conehealth',
    url: 'https://conehealth.wd5.myworkdayjobs.com/en-US/ConeHealthCareers' },
  { name: 'Virtua Health',             ats: 'workday', token: 'virtua',
    url: 'https://virtua.wd5.myworkdayjobs.com/en-US/Virtua' },
  { name: 'Valley Health System',      ats: 'workday', token: 'valleyhealthnj',
    url: 'https://valleyhealthnj.wd5.myworkdayjobs.com/en-US/careers' },
  { name: 'Billings Clinic',           ats: 'workday', token: 'billingsclinic',
    url: 'https://billingsclinic.wd5.myworkdayjobs.com/en-US/careers' },

  // Additional CS / BPO
  { name: 'DISH / EchoStar',           ats: 'workday', token: 'dish',
    url: 'https://dish.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Humana',                    ats: 'workday', token: 'humana',
    url: 'https://humana.wd5.myworkdayjobs.com/en-US/Humana_External' },
  { name: 'Cigna',                     ats: 'workday', token: 'cigna',
    url: 'https://cigna.wd5.myworkdayjobs.com/en-US/Cigna_Careers' },
  { name: 'Aetna / CVS',               ats: 'workday', token: 'aetna',
    url: 'https://aetna.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Anthem / Elevance',         ats: 'workday', token: 'elevancehealth',
    url: 'https://elevancehealth.wd5.myworkdayjobs.com/en-US/careers' },
  { name: 'UnitedHealth Group',        ats: 'workday', token: 'uhg',
    url: 'https://uhg.wd5.myworkdayjobs.com/en-US/UHG' },
  { name: 'Molina Healthcare',         ats: 'workday', token: 'molina',
    url: 'https://molina.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Centene',                   ats: 'workday', token: 'centene',
    url: 'https://centene.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Magellan Health',           ats: 'workday', token: 'magellanhealth',
    url: 'https://magellanhealth.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Aloha Care',                ats: 'greenhouse', token: 'alohacare' },
  { name: 'Asurion',                   ats: 'workday', token: 'asurion',
    url: 'https://asurion.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Wayfair',                   ats: 'greenhouse', token: 'wayfair' },
  { name: 'Chewy',                     ats: 'greenhouse', token: 'chewy' },
  { name: 'Zappos',                    ats: 'greenhouse', token: 'zappos' },
  { name: 'Jet.com / Walmart eComm',  ats: 'greenhouse', token: 'walmart' },
  { name: 'Overstock',                 ats: 'greenhouse', token: 'overstock' },
  { name: 'Hopper',                    ats: 'greenhouse', token: 'hopper' },
  { name: 'Outdoorsy',                 ats: 'lever',      token: 'outdoorsy' },
  { name: 'Lemonade',                  ats: 'greenhouse', token: 'lemonade' },
  { name: 'Root Insurance',            ats: 'greenhouse', token: 'rootinsurance' },
  { name: 'Hippo Insurance',           ats: 'greenhouse', token: 'hippo' },
  { name: 'Policygenius',              ats: 'greenhouse', token: 'policygenius' },

  // Additional logistics
  { name: 'DispatchTrack',             ats: 'greenhouse', token: 'dispatchtrack' },
  { name: 'Bringg',                    ats: 'greenhouse', token: 'bringg' },
  { name: 'Onfleet',                   ats: 'greenhouse', token: 'onfleet' },
  { name: 'Route',                     ats: 'greenhouse', token: 'route' },
  { name: 'AfterShip',                 ats: 'greenhouse', token: 'aftership' },
  { name: 'EasyPost',                  ats: 'greenhouse', token: 'easypost' },
  { name: 'Shippo',                    ats: 'greenhouse', token: 'shippo' },
  { name: 'Pirateship',                ats: 'ashby',      token: 'pirateship' },
  { name: 'Freightos',                 ats: 'greenhouse', token: 'freightos' },
  { name: 'Freight Club',              ats: 'lever',      token: 'freightclub' },
  { name: 'uShip',                     ats: 'greenhouse', token: 'uship' },
  { name: 'Dray Alliance',             ats: 'lever',      token: 'drayalliance' },
  { name: 'Transplace',                ats: 'greenhouse', token: 'transplace' },
  { name: 'Blue Yonder',               ats: 'workday', token: 'blueyonder',
    url: 'https://blueyonder.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'E2open',                    ats: 'workday', token: 'e2open',
    url: 'https://e2open.wd5.myworkdayjobs.com/en-US/External' },
  { name: 'Manhattan Associates',      ats: 'workday', token: 'manh',
    url: 'https://manh.wd5.myworkdayjobs.com/en-US/MANH_Careers' },
  { name: 'Körber Supply Chain',       ats: 'greenhouse', token: 'korber' },
  { name: 'Infor',                     ats: 'workday', token: 'infor',
    url: 'https://infor.wd5.myworkdayjobs.com/en-US/External' },
];

// doc-snapshot trigger: 2026-06-07
