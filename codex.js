/* =========================================================================
   CODEX.JS — Lore/reference data for every planet and moon in the
   Thessaly system. Pure data + small lookup helpers, no DOM, no physics —
   mirrors the separation-of-concerns already used by state.js (world
   data) vs. index.html (how it's displayed).

   Scope is deliberately planets + moons only (not stations): that's what
   was asked for, and it also keeps this aligned with what actually has
   gravity/a "you've arrived" moment worth narrating (see Physics.
   dominantBody) — a station is never a dominant body in this model, so
   there'd be no natural "entered orbit" trigger for one anyway.

   Each entry is independent prose, not a procedural template, so every
   world can have its own voice/tone rather than reading like the same
   mad-lib filled in four times.
   ========================================================================= */

const CODEX_DATA = {
  // ---------------------------------------------------------------------
  // ALDRIN — innermost planet: scorched mining world
  // ---------------------------------------------------------------------
  'aldrin': {
    type: 'Scorched Rock World',
    terrain: 'Cracked basalt flats and deep mineral canyons baked by Thessaly\'s glare. No surface water; what little atmosphere remains is thin, dry, and laced with sulfur from still-active vents along the equatorial rift.',
    habitability: 'Hostile. Surface temperatures swing from furnace-hot by day to bitter by night. All permanent population lives in shielded subterranean galleries or domed pressure habitats built into canyon walls.',
    population: '~2.1 million, almost entirely employees (and employees\' families) of the company that owns the mineral rights.',
    government: 'Corporate charter state. The Aldrin Extraction Authority holds the only colonial charter on the books and functions as landlord, employer, and local government all at once — there is no separate civil administration to appeal to.',
    history: 'First surveyed as a robotic strip-mining site generations ago; permanent habitation followed once assay teams confirmed the canyon veins ran deeper than anyone expected. What began as a rotating-shift outpost calcified into a hereditary company town within two generations, and it has run that way ever since.',
    news: [
      'A new vein under the Kessler Rift has triggered an internal scramble between extraction crews over bonus claims.',
      'The miners\' assembly has petitioned (again) for an independent safety inspector; the Authority has (again) declined.',
      'Automated haulers are being phased in on the lower galleries, with predictable unease among the crews they\'re replacing.',
    ],
    commoditiesLegal: ['Refined heavy metals', 'Industrial alloys', 'Processed ore concentrate', 'Geothermal components'],
    commoditiesIllegal: ['Untaxed raw ore run off-book through side tunnels', 'Counterfeit Authority work permits', 'Salvaged mining equipment with scrubbed serials'],
    personalities: [
      { name: 'Director Osei Vantry', role: 'Authority Site Director', blurb: 'Third-generation administrator who inherited the post from her father. Popular with shareholders, considerably less so on the gallery floor.' },
      { name: 'Teodor Hask', role: 'Assembly Shop Steward', blurb: 'Unofficial voice of the miners\' assembly. Has been "about to be fired" for a decade and somehow never is — which tells you something about how useful he is to keep around, happy or not.' },
    ],
    locations: [
      { id: 'aldrin-loc-kessler-gallery', name: 'Kessler Gallery', type: 'mining', orbital: false, description: 'A kilometers-deep gallery cut into the Kessler Rift, worked around the clock by rotating extraction crews chasing the vein confirmed richer than projected. The air inside tastes faintly of scorched rock no amount of scrubbing ever quite clears.' },
      { id: 'aldrin-loc-hearthline', name: 'Hearthline', type: 'city', orbital: false, description: "The Authority's primary settlement, built into the canyon wall behind triple-sealed pressure doors. Multi-generational families live stacked in converted gallery housing, and the central concourse is as close as Aldrin gets to a town square." },
      { id: 'aldrin-loc-vantry-point', name: 'Vantry Point Spaceport', type: 'spaceport', orbital: false, description: "Aldrin's only certified landing field, named for the Director's grandfather. Every gram of refined ore that leaves the planet passes through its cargo bays first, under the Authority's watchful inventory." },
      { id: 'aldrin-loc-authority-hall', name: 'Authority Hall', type: 'government', orbital: false, description: "The Extraction Authority's administrative seat, where Director Vantry's office and the company's entire bureaucratic apparatus occupy floors cut directly into solid rock. The miners' assembly's petitions go here to be, politely, declined." },
    ],
  },
  'aldrin-moon1': {
    type: 'Processing Moon (Industrial)',
    terrain: 'Airless and gray, its surface almost entirely given over to refinery stacks, slag terraces, and the long rail gantries that catch ore canisters fired up from Aldrin\'s surface.',
    habitability: 'None, by design. No permanent residents — the whole moon is automated, with only short-rotation maintenance crews aboard at any time.',
    population: 'A few hundred, on rotating two-week maintenance shifts.',
    government: 'Administered directly by the Aldrin Extraction Authority as a processing facility, not a settlement — there is no local governance to speak of.',
    history: 'Converted from a bare captured rock into a smelting platform early in Aldrin\'s development, once it became clear refining in low gravity and vacuum was cheaper than doing it dirtside.',
    news: [
      'A gantry realignment has briefly suspended canister launches from Aldrin, backing up surface stockpiles.',
      'Maintenance crews are pushing for hazard pay after a slag-terrace venting incident last rotation.',
    ],
    commoditiesLegal: ['Smelted metal ingots', 'Refinery byproducts (sold as industrial feedstock)'],
    commoditiesIllegal: ['Diverted ingot shipments quietly resold before manifest'],
    personalities: [
      { name: 'Foreman Culley Arnab', role: 'Shift Foreman', blurb: 'Runs the maintenance rotations and is, by most accounts, the only person who actually understands the gantry scheduling software anymore.' },
    ],
    locations: [
      { id: 'aldrin-moon1-loc-gantry-complex', name: 'Gantry Processing Complex', type: 'industrial', orbital: false, description: "The moon's central smelting operation, a sprawl of refinery stacks and slag terraces fed by ore canisters fired up from Aldrin's surface. It runs itself, mostly — the maintenance crews are here to keep it that way." },
      { id: 'aldrin-moon1-loc-catch-platform-7', name: 'Catch Platform Seven', type: 'outpost', orbital: false, description: 'One of several ore-canister catch platforms strung along the rail gantry line, staffed by a skeleton crew whose entire job is making sure nothing arriving at high velocity misses its mark.' },
    ],
  },
  'aldrin-moon2': {
    type: 'Independent Claims Moon',
    terrain: 'Pocked with small-scale dig sites and improvised habitat domes, scattered rather than planned — every claim staked by whoever got there first.',
    habitability: 'Marginal but livable in pressurized shelters; several hundred independent miners have made a go of it anyway.',
    population: '~4,000, mostly former Aldrin Extraction Authority employees who bought out their contracts to prospect independently.',
    government: 'No formal government — claims are self-policed by a loose, frequently-litigated code of first-stake-wins, with disputes settled by a rotating panel of senior claimholders.',
    history: 'Settled piecemeal over the last generation by miners who decided the Authority\'s cut wasn\'t worth it. The Authority tolerates the moon\'s independence mainly because buying everyone out would cost more than it\'s worth.',
    news: [
      'A boundary dispute between two adjacent claims has gone to the claimholders\' panel for the third time this year.',
      'Rumors persist of a rich seam near the terminator line that nobody has officially staked yet.',
    ],
    commoditiesLegal: ['Independently-assayed raw ore', 'Hand-fabricated habitat parts'],
    commoditiesIllegal: ['Ore laundered through here to obscure its Aldrin-Authority origin', 'Unlicensed excavation charges'],
    personalities: [
      { name: '"Bones" Okonkwo-Reyes', role: 'Senior Claimholder', blurb: 'Oldest prospector still digging on the moon, and by informal consensus the final word when the claimholders\' panel deadlocks.' },
    ],
    locations: [
      { id: 'aldrin-moon2-loc-reyes-camp', name: 'Reyes Camp', type: 'mining', orbital: false, description: "One of the moon's oldest independent dig sites, worked by prospectors who bought out their Authority contracts rather than renew them. The claim markers here predate most of the moon's newer arrivals." },
      { id: 'aldrin-moon2-loc-claim-line', name: 'The Claim Line', type: 'town', orbital: false, description: "A strip of habitat domes and trade stalls that grew up where several claims' boundaries happened to meet, now the closest thing the moon has to a shared settlement — and the usual venue when the claimholders' panel needs to convene." },
    ],
  },

  // ---------------------------------------------------------------------
  // MERIDIAN — second planet: the system's capital world
  // ---------------------------------------------------------------------
  'meridian': {
    type: 'Temperate World',
    terrain: 'Rolling grasslands, broad temperate forests, and three shallow seas connected by wide river deltas. The most Earth-like world in the system by a wide margin.',
    habitability: 'High. Open-air settlement is comfortable across most of the temperate band; only the polar regions need real climate gear.',
    population: '~54 million — by far the system\'s largest.',
    government: 'The Thessaly Accord: an elected council republic headquartered in Meridian\'s capital, and the closest thing the system has to a unifying authority, though its actual jurisdiction over the other worlds is more aspirational than enforced.',
    history: 'Settled as the system\'s primary colonization target once early surveys confirmed its climate, Meridian grew into the system\'s political and cultural center almost by default — it was simply the only world where you didn\'t need a dome to raise a family.',
    news: [
      'Council elections are six weeks out, with tariff policy toward Aldrin\'s ore exports the dominant issue.',
      'The Harborfront Festival returns to the capital this season after a two-year hiatus.',
      'A council inquiry into customs-office favoritism has subpoenaed records from three shipping concerns.',
    ],
    commoditiesLegal: ['Agricultural exports', 'Manufactured consumer goods', 'Medical technology', 'Printed media and entertainment'],
    commoditiesIllegal: ['Unlicensed cybernetic augmentation', 'Counterfeit branded goods', 'Diverted pharmaceuticals'],
    personalities: [
      { name: 'Chancellor Imara Dovetsky', role: 'Head of the Thessaly Accord Council', blurb: 'Two terms in, popular but increasingly dogged by the customs-favoritism inquiry she herself called for.' },
      { name: 'Renn Okafor-Lind', role: 'Investigative Correspondent', blurb: 'Runs the independent feed that broke the customs story. Has a standing reputation for printing things certain council members wish she wouldn\'t.' },
    ],
    locations: [
      { id: 'meridian-loc-harborfront', name: 'Harborfront Capital', type: 'city', orbital: false, description: "Meridian's seat of government and largest population center, built along the river delta where the Harborfront Festival returns each season. Council business and festival crowds share the same waterfront streets most of the year." },
      { id: 'meridian-loc-thessaly-hall', name: 'Thessaly Hall', type: 'government', orbital: false, description: "The Accord Council's chamber and administrative heart, where Chancellor Dovetsky's inquiry into customs favoritism is currently being argued out in committee rooms down every corridor." },
      { id: 'meridian-loc-central-spaceport', name: 'Meridian Central Spaceport', type: 'spaceport', orbital: false, description: 'The system\'s busiest civilian port by a wide margin, handling everything from agricultural exports to the manufactured goods that make their way to every other world in Thessaly.' },
      { id: 'meridian-loc-rivermouth', name: 'Rivermouth', type: 'town', orbital: false, description: "A quieter delta town upriver from the capital, mostly agricultural trade and the kind of unhurried pace people from Harborfront complain they don't have time for." },
      { id: 'meridian-loc-greenbelt-works', name: 'Greenbelt Works', type: 'industrial', orbital: false, description: 'A manufacturing district turning out consumer goods and medical technology for export, dense with fabrication plants that run three shifts to keep pace with system-wide demand.' },
    ],
  },
  'meridian-moon1': {
    type: 'Orbital Shipyard Moon',
    terrain: 'A rocky, lightly-cratered moon almost entirely ringed by orbital drydocks and berthing frames rather than surface development — most of what matters here never touches the ground.',
    habitability: 'Low surface habitability, but irrelevant — nearly everyone lives and works in the orbital yards rather than on the moon itself.',
    population: '~900,000, mostly shipyard workers and their families housed in orbital habitat rings.',
    government: 'A chartered yard authority answerable to the Thessaly Accord council, with day-to-day operations run by the dockmasters\' guild.',
    history: 'Chosen as the system\'s primary shipyard site for its stable orbit and proximity to Meridian\'s manufacturing base. Has built or refitted a sizable share of every registered vessel in the system at one point or another.',
    news: [
      'A backlog of refit contracts has the dockmasters\' guild petitioning for a second berthing frame.',
      'A newly-launched bulk freighter suffered a minor hull-seam failure on its maiden burn, prompting a quiet inquiry into the welding contractor.',
    ],
    commoditiesLegal: ['Ship hulls and components', 'Fabrication contracts', 'Orbital berthing services'],
    commoditiesIllegal: ['Unregistered hull modifications (smuggling compartments, stripped transponders)'],
    personalities: [
      { name: 'Dockmaster Priya Ashwell', role: 'Guild Dockmaster', blurb: 'Has final say over berth scheduling system-wide and is famously immune to bribery — mostly, people suspect, because she enjoys the leverage of being the one thing money can\'t move.' },
    ],
    locations: [
      { id: 'meridian-moon1-loc-ashwell-yards', name: 'Ashwell Yards', type: 'industrial', orbital: true, description: "The moon's primary drydock and fabrication complex, where a sizable share of every registered vessel in the system has been built or refitted at least once. Dockmaster Ashwell's berth schedule runs the place with famous precision." },
      { id: 'meridian-moon1-loc-berthing-ring-4', name: 'Berthing Ring Four', type: 'orbital', orbital: true, description: "One of several orbital habitat rings housing shipyard workers and their families — most residents here have never set foot on the moon's actual surface, and see little reason to start." },
    ],
  },
  'meridian-moon2': {
    type: 'Agricultural & Research Moon',
    terrain: 'Terraformed growing domes spread across an otherwise barren gray surface, feeding a tightly-controlled artificial microclimate inside each one.',
    habitability: 'Livable only within the domes; the surface outside them is airless.',
    population: '~1.3 million, split between agricultural staff and the university research faculty.',
    government: 'Jointly administered by the Meridian Agricultural Cooperative and Thessaly University\'s extension campus — an unusually cooperative arrangement by system standards.',
    history: 'Developed as a controlled-environment farming moon once Meridian\'s own population began to outpace its traditional agriculture, with a research campus added later to study closed-ecosystem efficiency.',
    news: [
      'A new dome-crop strain promises higher yields but has drawn skepticism from traditional cooperative growers.',
      'University researchers report a promising (if early) breakthrough in closed-loop nutrient cycling.',
    ],
    commoditiesLegal: ['High-yield grain and produce', 'Agricultural research licensing', 'Seed stock'],
    commoditiesIllegal: ['Patent-infringing bootleg seed stock sold off-manifest'],
    personalities: [
      { name: 'Professor Aldous Rin', role: 'Extension Campus Director', blurb: 'Equal parts agronomist and administrator, and reportedly much happier when he gets to be the former.' },
    ],
    locations: [
      { id: 'meridian-moon2-loc-dome-coop-7', name: 'Dome Cooperative Seven', type: 'industrial', orbital: false, description: "One of dozens of sealed growing domes spread across the moon's barren surface, each a tightly-controlled artificial microclimate turning out the high-yield grain strains feeding Meridian's growing population." },
      { id: 'meridian-moon2-loc-university-extension', name: 'Thessaly University Extension', type: 'government', orbital: false, description: "The university's off-world research campus, where Professor Rin's faculty study closed-ecosystem efficiency in facilities built right alongside the cooperative's working farms." },
    ],
  },

  // ---------------------------------------------------------------------
  // VESPER — third planet: ocean world of maritime guilds
  // ---------------------------------------------------------------------
  'vesper': {
    type: 'Ocean World',
    terrain: 'Overwhelmingly water, broken only by volcanic archipelago chains and a handful of larger island landmasses. Frequent, powerful storm systems sweep the open ocean.',
    habitability: 'Moderate. Coastal and floating settlements are well-established, but the open ocean and its storm season remain genuinely dangerous.',
    population: '~8.6 million, concentrated in island cities and anchored floating platforms.',
    government: 'A federation of maritime guild city-states, each governing its own waters and platforms, loosely coordinated through a rotating guild council that meets between storm seasons.',
    history: 'Settled by colonists who deliberately chose distance from Meridian\'s growing central government, Vesper built its identity around the sea — its guild structure grew directly out of the old shipping consortiums that first charted its archipelagos.',
    news: [
      'An early and unusually severe storm season has disrupted shipping lanes between three major guild platforms.',
      'The guild council is debating a new tariff on deep-sea salvage rights after a contested wreck claim.',
      'A research vessel reports unusual mineral readings from a newly-charted trench.',
    ],
    commoditiesLegal: ['Aquaculture and seafood exports', 'Desalinated water and processed ice', 'Marine biochemical compounds'],
    commoditiesIllegal: ['Unregulated "void coral" — a deep-trench growth prized and restricted for its biochemical properties', 'Unlicensed salvage of pre-colonial wreck sites'],
    personalities: [
      { name: 'Harbor-Mother Ysolde Kapoor', role: 'Rotating Guild Council Chair', blurb: 'Currently holds the council\'s rotating chair and has used it to push the contested salvage-tariff proposal harder than most of her predecessors bothered to.' },
      { name: 'Captain Reyo Dunmore', role: 'Independent Salvage Captain', blurb: 'Runs salvage operations that stay just inside (or suspiciously close to the edge of) guild law, depending who you ask.' },
    ],
    locations: [
      { id: 'vesper-loc-kapoors-reach', name: "Kapoor's Reach", type: 'city', orbital: false, description: "One of Vesper's largest anchored platform cities, home port to Harbor-Mother Kapoor's own guild and a dense tangle of floating docks, markets, and stacked habitat decks riding out the storm season together." },
      { id: 'vesper-loc-rotating-hall', name: 'The Rotating Hall', type: 'government', orbital: false, description: 'A platform built to host the guild council whenever its rotating chair calls session — currently occupied by Harbor-Mother Kapoor, who has used the post more aggressively than most who\'ve held it before her.' },
      { id: 'vesper-loc-dunmores-yard', name: "Dunmore's Salvage Yard", type: 'industrial', orbital: false, description: "A working waterfront yard where Captain Dunmore's crews bring in deep-sea salvage of questionable provenance, processed just fast enough to stay ahead of anyone asking too many questions about where it came from." },
      { id: 'vesper-loc-tidewater-spaceport', name: 'Tidewater Spaceport', type: 'spaceport', orbital: false, description: "A reinforced floating landing platform built to ride out Vesper's storm season, handling the aquaculture and marine biochemical exports that leave the planet by the shipload." },
    ],
  },
  'vesper-moon1': {
    type: 'Relay & Weather-Watch Moon',
    terrain: 'Small, airless, and largely given over to the dish arrays and sensor masts that track Vesper\'s storm systems from orbit.',
    habitability: 'None meaningful — a skeleton crew keeps the relay station running.',
    population: 'Under 200, all station staff.',
    government: 'Operated directly by the Vesper guild council as shared infrastructure, exempt from any single guild\'s territorial claim.',
    history: 'Established once it became clear that orbital storm-tracking saved more ships than any amount of surface-based forecasting ever had.',
    news: [
      'A sensor mast realignment has temporarily degraded storm-tracking resolution over the eastern archipelago.',
    ],
    commoditiesLegal: ['Weather and navigation data subscriptions'],
    commoditiesIllegal: ['Sold-ahead storm forecasts used for insider shipping advantage'],
    personalities: [
      { name: 'Station Chief Wen Odalis', role: 'Relay Station Chief', blurb: 'Has spent more consecutive years on this moon than anyone else currently alive, and insists she prefers it that way.' },
    ],
    locations: [
      { id: 'vesper-moon1-loc-odalis-relay', name: 'Odalis Relay Station', type: 'orbital', orbital: true, description: "A skeleton-crewed station built almost entirely around its dish arrays and sensor masts, tracking Vesper's storm systems from orbit under Station Chief Odalis, who has outlasted every rotation partner she's ever had." },
    ],
  },
  'vesper-moon2': {
    type: 'Free Port Moon',
    terrain: 'A patchwork of pressurized hab-cylinders and docking frames bolted onto a bare rock with no formal development plan — it grew the way markets grow, not the way cities are planned.',
    habitability: 'Marginal, pressurized-habitat only, but busy regardless.',
    population: '~60,000, transient and permanent residents both, with no reliable census.',
    government: 'No guild claims it, which is precisely the point — it operates as an unregulated free port where Vesper\'s guild law doesn\'t reach.',
    history: 'Grew up around a single unlicensed trading post that no guild wanted to take responsibility for policing, and simply kept growing once it became clear no one was going to stop it.',
    news: [
      'A fresh wave of traders has arrived ahead of Vesper\'s storm season, crowding the docking frames.',
      'Unconfirmed reports describe a guild enforcement patrol turned away at the edge of the moon\'s claimed space.',
    ],
    commoditiesLegal: ['General trade goods of every description, lightly taxed and lightly inspected'],
    commoditiesIllegal: ['Effectively anything — this moon\'s entire economy runs on goods that wouldn\'t clear inspection anywhere else in the system'],
    personalities: [
      { name: '"Ledger" Hale', role: 'Unofficial Port Broker', blurb: 'Nobody elected her anything, but every deal of consequence on the moon seems to pass through her somehow.' },
    ],
    locations: [
      { id: 'vesper-moon2-loc-hales-market', name: "Hale's Market", type: 'town', orbital: false, description: "A sprawling, unplanned tangle of hab-cylinders and trade stalls that grew the way markets grow rather than the way cities are planned — and where most deals of consequence somehow pass through Ledger Hale's hands first." },
      { id: 'vesper-moon2-loc-open-frames', name: 'The Open Frames', type: 'spaceport', orbital: false, description: "Unlicensed, unregulated docking frames crowded with traders ahead of Vesper's storm season — no guild claims jurisdiction here, and no guild inspector bothers trying." },
    ],
  },

  // ---------------------------------------------------------------------
  // KRYOS — outermost planet: frozen frontier
  // ---------------------------------------------------------------------
  'kryos': {
    type: 'Ice World',
    terrain: 'Deep glacial plains over a suspected subsurface ocean, scoured by thin, bitterly cold winds. Geothermal vents near the equator offer the only naturally warm ground on the planet.',
    habitability: 'Low. Settlement survives on geothermal-heated domes and buried shelters; nothing lives on the open ice for long.',
    population: '~480,000, the smallest of the four planets by a wide margin.',
    government: 'A loose outpost council with minimal real authority — Kryos is nominally part of the Thessaly Accord but sits far enough out that enforcement rarely reaches it.',
    history: 'Founded as a scientific research station studying the subsurface ocean and the planet\'s ancient ice strata. The research mission never left, but over time it was joined — and arguably outgrown — by traders and settlers drawn to a world far enough from everyone else to be left alone.',
    news: [
      'The research station reports anomalous readings from deep in the subsurface ocean, details unreleased pending further study.',
      'Outpost council members have again raised concerns about the near-total absence of system patrol presence this far out.',
      'A supply convoy arrived three weeks late this cycle, reviving old complaints about Kryos being last in line for everything.',
    ],
    commoditiesLegal: ['Cryo-preserved biological samples', 'Rare industrial ices', 'Research data and survey rights'],
    commoditiesIllegal: ['Unregistered weapons', 'Stolen goods fenced through outpost traders', 'Unlicensed stimulants — Kryos\'s minimal oversight makes it the system\'s de facto smuggling hub'],
    personalities: [
      { name: 'Dr. Senna Voklund', role: 'Lead Research Scientist', blurb: 'Has run the subsurface-ocean survey for over a decade and is notably tight-lipped about what the latest readings actually show.' },
      { name: '"Convoy" Bresh Talon', role: 'Outpost Trader', blurb: 'Widely assumed to broker more than legitimate supply contracts, though nothing has ever been proven — or, more likely, no one with the authority to prove it has ever really tried.' },
    ],
    locations: [
      { id: 'kryos-loc-voklund-station', name: 'Voklund Station', type: 'government', orbital: false, description: "The original research station, still the closest thing Kryos has to an official authority. Dr. Voklund's subsurface-ocean survey occupies most of the station, and she is saying remarkably little about its latest readings." },
      { id: 'kryos-loc-outpost-hearth', name: 'Outpost Hearth', type: 'town', orbital: false, description: "Kryos's main settlement, built around one of the planet's few naturally warm geothermal vents. Domes and buried shelters cluster close to the heat the way settlements elsewhere cluster around water." },
      { id: 'kryos-loc-talons-dock', name: "Talon's Dock", type: 'spaceport', orbital: false, description: '"Convoy" Bresh Talon\'s supply contracts — and, by persistent rumor, considerably more than that — pass through this cold, lightly-inspected landing field on their way in or out of the system\'s most isolated planet.' },
    ],
  },
  'kryos-moon1': {
    type: 'Abandoned Claim Moon',
    terrain: 'The husk of a failed mining operation — collapsed excavation frames and a handful of sealed, long-dead habitat domes half-buried in ice creep.',
    habitability: 'None. Uninhabited, officially, though the occasional salvager insists otherwise.',
    population: '0 permanent residents (unconfirmed transient salvage activity).',
    government: 'None — the original mining charter lapsed generations ago and was never renewed.',
    history: 'An early mining venture that folded within a few years once the ice proved harder to work than projected. The equipment was never fully salvaged, left too far out to be worth the retrieval cost at the time.',
    news: [
      'A salvage crew reportedly spent several weeks here last season; what, if anything, they recovered is unclear.',
    ],
    commoditiesLegal: ['Nothing traded openly — occasional salvaged scrap metal'],
    commoditiesIllegal: ['A convenient, unwatched waypoint for cargo no one wants scanned'],
    personalities: [],
    locations: [
      { id: 'kryos-moon1-loc-collapsed-frames', name: 'The Collapsed Frames', type: 'outpost', orbital: false, description: 'The husk of a mining venture that folded within a few years, its excavation frames collapsed and half-buried in ice creep. Officially abandoned; unofficially, salvage crews pass through often enough to keep a faint trail worn through the frost.' },
    ],
  },
  'kryos-moon2': {
    type: 'Hidden Outpost Moon',
    terrain: 'Rugged and cratered, with one unremarkable-looking crater floor concealing a far more developed installation than its exterior suggests.',
    habitability: 'Survivable within the concealed installation; openly hostile everywhere else on the surface.',
    population: 'Unknown — estimates range from a few hundred to several thousand, depending who\'s asked.',
    government: 'None acknowledged publicly. Widely believed, though never confirmed, to be the operational base behind much of Kryos\'s smuggling trade.',
    history: 'Officially uninhabited and unsurveyed. Unofficially, persistent rumors place a well-equipped and well-hidden settlement here, allegedly responsible for a sizable share of the region\'s illicit trade — though no outpost council inquiry has ever produced proof, or perhaps ever genuinely tried to.',
    news: [
      'Nothing official is ever reported about this moon — which is, itself, the thing most often remarked upon.',
    ],
    commoditiesLegal: [],
    commoditiesIllegal: ['Rumored to be the staging point for most of the system\'s serious contraband trade, though by its nature none of this is confirmed'],
    personalities: [
      { name: '(Unconfirmed)', role: 'Alleged Operator', blurb: 'No name is reliably attached to whoever — if anyone — actually runs this place. Every story names someone different.' },
    ],
    locations: [
      { id: 'kryos-moon2-loc-crater-floor', name: 'The Crater Floor', type: 'military', orbital: false, description: 'An unremarkable crater that conceals a far more developed, far better-defended installation than its surface suggests. No outpost council inquiry has ever gotten past the perimeter — assuming anyone ever genuinely tried.' },
    ],
  },
};

const Codex = (() => {
  function getEntry(bodyId) {
    return CODEX_DATA[bodyId] || null;
  }

  function hasEntry(bodyId) {
    return !!CODEX_DATA[bodyId];
  }

  // Every named location at a body (the planet-map popup's pins, each
  // mission's actual origin/destination) — always an array, even for a
  // body with no codex entry at all, so callers never need a separate
  // null-check before iterating.
  function getLocations(bodyId) {
    const entry = CODEX_DATA[bodyId];
    return (entry && entry.locations) || [];
  }

  function getLocation(bodyId, locationId) {
    return getLocations(bodyId).find(loc => loc.id === locationId) || null;
  }

  // A uniformly-random location at a body, or null for a body with none
  // (shouldn't happen for any of the 12 planets/moons, but a station or
  // any future body without a codex entry has no locations to offer).
  function randomLocation(bodyId) {
    const locs = getLocations(bodyId);
    return locs.length ? locs[Math.floor(Math.random() * locs.length)] : null;
  }

  // Returns every codex-covered body in `system`, grouped by planet in
  // orbit order, each with its moons (if any) in orbit order — exactly
  // the structure a directory listing wants, without the UI layer
  // needing to know anything about how planets/moons relate to each
  // other (that's system.bodies' job via parentId, not the codex's).
  function listByPlanet(system) {
    const planets = system.bodies
      .filter(b => b.kind === BodyKind.PLANET && hasEntry(b.id))
      .sort((a, b) => a.orbitRadius - b.orbitRadius);
    return planets.map(planet => ({
      body: planet,
      moons: system.bodies
        .filter(b => b.kind === BodyKind.MOON && b.parentId === planet.id && hasEntry(b.id))
        .sort((a, b) => a.orbitRadius - b.orbitRadius),
    }));
  }

  return { getEntry, hasEntry, getLocations, getLocation, randomLocation, listByPlanet };
})();
