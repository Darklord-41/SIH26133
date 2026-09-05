/**
 * Seed script: populates 50 rural Maharashtra health facilities
 * (Sub Centres, PHCs, CHCs, Rural & District Hospitals) with realistic
 * district/taluka geography and per-facility medicine inventory.
 *
 * Run with: npm run seed  (or `npx prisma db seed`)
 */

const { PrismaClient, FacilityType } = require("@prisma/client");
const prisma = new PrismaClient();

// Real Maharashtra district -> taluka -> approx lat/lng anchors (rural belt).
// Coordinates are approximate taluka-town centroids, fine for demo/map purposes.
const DISTRICT_TALUKAS = [
  { district: "Pune", talukas: ["Shirur", "Baramati", "Junnar", "Velhe", "Mulshi"], lat: 18.53, lng: 74.0 },
  { district: "Nashik", talukas: ["Igatpuri", "Trimbakeshwar", "Dindori", "Peth", "Niphad"], lat: 20.0, lng: 73.78 },
  { district: "Ahmednagar", talukas: ["Shrirampur", "Karjat", "Jamkhed", "Akole", "Parner"], lat: 19.09, lng: 74.74 },
  { district: "Satara", talukas: ["Mahabaleshwar", "Wai", "Phaltan", "Man", "Koregaon"], lat: 17.68, lng: 74.0 },
  { district: "Sangli", talukas: ["Miraj", "Jat", "Atpadi", "Kavathe Mahankal", "Shirala"], lat: 16.85, lng: 74.57 },
  { district: "Kolhapur", talukas: ["Panhala", "Shahuwadi", "Radhanagari", "Gaganbawada", "Chandgad"], lat: 16.7, lng: 74.23 },
  { district: "Solapur", talukas: ["Barshi", "Karmala", "Malshiras", "Sangole", "Akkalkot"], lat: 17.66, lng: 75.9 },
  { district: "Aurangabad", talukas: ["Vaijapur", "Gangapur", "Paithan", "Kannad", "Sillod"], lat: 19.88, lng: 75.34 },
  { district: "Beed", talukas: ["Georai", "Ambajogai", "Parli", "Kaij", "Dharur"], lat: 18.99, lng: 75.76 },
  { district: "Yavatmal", talukas: ["Pusad", "Darwha", "Umarkhed", "Ner", "Wani"], lat: 20.39, lng: 78.13 },
];

const FACILITY_TYPE_MIX = [
  { type: FacilityType.SUBCENTRE, weight: 0.4 },
  { type: FacilityType.PHC, weight: 0.32 },
  { type: FacilityType.CHC, weight: 0.16 },
  { type: FacilityType.RURAL_HOSPITAL, weight: 0.08 },
  { type: FacilityType.DISTRICT_HOSPITAL, weight: 0.04 },
];

const SPECIALIST_POOL = ["GYNAC", "ORTHO", "PEDIATRIC", "GENERAL_SURGEON", "ANAESTHETIST"];

const MEDICINE_CATALOG = [
  { name: "Paracetamol 500mg", unit: "tablets", min: 200, max: 2000 },
  { name: "ORS Sachets", unit: "sachets", min: 100, max: 1000 },
  { name: "Iron Folic Acid Tablets", unit: "tablets", min: 150, max: 1500 },
  { name: "Amoxicillin 250mg", unit: "capsules", min: 100, max: 800 },
  { name: "Oxytocin Injection", unit: "vials", min: 20, max: 200 },
  { name: "IV Fluid (Normal Saline)", unit: "bottles", min: 30, max: 300 },
  { name: "Snake Anti-Venom", unit: "vials", min: 5, max: 50 },
  { name: "Measles Vaccine", unit: "vials", min: 10, max: 150 },
  { name: "Zinc Sulphate Tablets", unit: "tablets", min: 100, max: 1000 },
  { name: "Chlorhexidine Gel", unit: "tubes", min: 20, max: 200 },
];

function pickWeighted(pool) {
  const r = Math.random();
  let acc = 0;
  for (const p of pool) {
    acc += p.weight;
    if (r <= acc) return p.type;
  }
  return pool[pool.length - 1].type;
}

function jitter(base, spread = 0.15) {
  return +(base + (Math.random() - 0.5) * spread).toFixed(5);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  console.log("Clearing existing data (dependent-first order)...");
  await prisma.smsTelemetry.deleteMany();
  await prisma.syncEvent.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.triage.deleteMany();
  await prisma.patient.deleteMany();
  await prisma.inventory.deleteMany();
  await prisma.facility.deleteMany();

  console.log("Generating 50 facilities...");

  const facilitiesToCreate = [];
  const usedCodes = new Set();
  let counter = 0;

  while (facilitiesToCreate.length < 50) {
    const region = DISTRICT_TALUKAS[counter % DISTRICT_TALUKAS.length];
    const taluka = region.talukas[Math.floor(Math.random() * region.talukas.length)];
    const type = pickWeighted(FACILITY_TYPE_MIX);

    const prefix =
      type === FacilityType.SUBCENTRE ? "SC" :
      type === FacilityType.PHC ? "PHC" :
      type === FacilityType.CHC ? "CHC" :
      type === FacilityType.RURAL_HOSPITAL ? "RH" : "DH";

    const talukaCode = taluka.toUpperCase().replace(/\s+/g, "_").slice(0, 12);
    let facilityCode = `${prefix}_${talukaCode}`;
    let suffix = 1;
    while (usedCodes.has(facilityCode)) {
      suffix += 1;
      facilityCode = `${prefix}_${talukaCode}_${suffix}`;
    }
    usedCodes.add(facilityCode);

    const isBigFacility = type === FacilityType.RURAL_HOSPITAL || type === FacilityType.DISTRICT_HOSPITAL;
    const bedsTotal = type === FacilityType.SUBCENTRE ? 0
      : type === FacilityType.PHC ? randInt(4, 10)
      : type === FacilityType.CHC ? randInt(15, 30)
      : type === FacilityType.RURAL_HOSPITAL ? randInt(30, 60)
      : randInt(80, 200);

    const bedsAvailable = bedsTotal === 0 ? 0 : randInt(0, bedsTotal);
    const hasSpecialist = isBigFacility || (type === FacilityType.CHC && Math.random() > 0.4);
    const specialistTypes = hasSpecialist
      ? SPECIALIST_POOL.filter(() => Math.random() > 0.5)
      : [];

    facilitiesToCreate.push({
      facilityCode,
      name: `${type === FacilityType.SUBCENTRE ? "Sub Centre" :
              type === FacilityType.PHC ? "Primary Health Centre" :
              type === FacilityType.CHC ? "Community Health Centre" :
              type === FacilityType.RURAL_HOSPITAL ? "Rural Hospital" : "District Hospital"} ${taluka}`,
      type,
      district: region.district,
      taluka,
      village: type === FacilityType.SUBCENTRE ? `${taluka} Village ${randInt(1, 9)}` : null,
      latitude: jitter(region.lat),
      longitude: jitter(region.lng),
      xrayStatus: isBigFacility ? Math.random() > 0.15 : (type === FacilityType.CHC && Math.random() > 0.5),
      icuAvailable: type === FacilityType.DISTRICT_HOSPITAL || (type === FacilityType.RURAL_HOSPITAL && Math.random() > 0.6),
      bedsTotal,
      bedsAvailable,
      hasSpecialist,
      specialistTypes,
      contactNumber: `+91${randInt(7000000000, 9999999999)}`,
      isActive: true,
    });

    counter += 1;
  }

  console.log("Inserting facilities + inventory transactionally...");

  for (const facilityData of facilitiesToCreate) {
    const facility = await prisma.facility.create({ data: facilityData });

    // Every facility stocks a random 6-10 medicines from the catalog
    const stockCount = randInt(6, MEDICINE_CATALOG.length);
    const shuffled = [...MEDICINE_CATALOG].sort(() => Math.random() - 0.5).slice(0, stockCount);

    await prisma.inventory.createMany({
      data: shuffled.map((med) => {
        const minimumThreshold = med.min;
        // ~20% of rows deliberately seeded LOW so /inventory/alerts has real data to show
        const isLow = Math.random() < 0.2;
        const currentStock = isLow
          ? randInt(0, minimumThreshold - 1)
          : randInt(minimumThreshold, med.max);

        return {
          facilityId: facility.id,
          medicineName: med.name,
          unit: med.unit,
          currentStock,
          minimumThreshold,
          maximumCapacity: med.max,
        };
      }),
    });
  }

  const facilityCount = await prisma.facility.count();
  const inventoryCount = await prisma.inventory.count();
  // Column-to-column comparison needs a raw query since Prisma's filter API
  // can't compare currentStock <= minimumThreshold directly.
  const lowStockRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM "Inventory" WHERE "currentStock" <= "minimumThreshold"`
  );
  const lowStockCount = lowStockRows?.[0]?.count ?? "n/a";

  console.log(`Done. Facilities: ${facilityCount}, Inventory rows: ${inventoryCount}, Low-stock rows: ${lowStockCount}`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
