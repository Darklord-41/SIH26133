const { v4: uuidv4 } = require("uuid");
const prisma = require("../lib/prisma");

// ---------------------------------------------------------------------------
// 1. EDIT PROFILE & ABHA ID LINKING
// ---------------------------------------------------------------------------

/**
 * PUT /api/v1/patient/profile
 * Update citizen profile details and sync longitudinal Patient record
 */
async function updateProfile(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const { name, age, gender, phone, village } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        name: name ? String(name).trim() : undefined,
        phone: phone ? String(phone).trim() : undefined,
      },
    });

    // Find or create associated longitudinal Patient record
    let patient = await prisma.patient.findFirst({
      where: {
        OR: [
          { userId: req.user.id },
          { phone: updatedUser.phone || req.user.phone || undefined },
        ],
      },
    });

    if (!patient) {
      // Find a default facility to associate or use the first available facility
      const defaultFacility = await prisma.facility.findFirst();
      patient = await prisma.patient.create({
        data: {
          userId: req.user.id,
          name: updatedUser.name || "Citizen Patient",
          age: age ? Number(age) : null,
          gender: gender || null,
          phone: updatedUser.phone || req.user.phone || null,
          village: village || null,
          facilityId: defaultFacility ? defaultFacility.id : undefined,
        },
      });
    } else {
      patient = await prisma.patient.update({
        where: { id: patient.id },
        data: {
          userId: req.user.id,
          name: name ? String(name).trim() : patient.name,
          age: age ? Number(age) : patient.age,
          gender: gender || patient.gender,
          phone: phone ? String(phone).trim() : patient.phone,
          village: village ? String(village).trim() : patient.village,
        },
      });
    }

    return res.status(200).json({
      message: "Patient profile updated successfully",
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        phone: updatedUser.phone,
        email: updatedUser.email,
        role: updatedUser.role,
        abhaId: updatedUser.abhaId,
        abhaVerified: updatedUser.abhaVerified,
      },
      patientProfile: patient,
    });
  } catch (err) {
    console.error("Error in updateProfile:", err);
    return res.status(500).json({ error: "Failed to update profile", detail: err.message });
  }
}

/**
 * POST /api/v1/patient/abha/link
 * Link & verify Ayushman Bharat Health Account (ABHA ID)
 */
async function linkAbhaId(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const { abhaId } = req.body;
    if (!abhaId) {
      return res.status(400).json({ error: "ABHA ID is required" });
    }

    const cleanAbha = String(abhaId).trim();

    // Check if ABHA ID is already taken by another user
    const existingUser = await prisma.user.findFirst({
      where: {
        abhaId: cleanAbha,
        id: { not: req.user.id },
      },
    });

    if (existingUser) {
      return res.status(400).json({ error: "This ABHA ID is already linked to another account" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        abhaId: cleanAbha,
        abhaVerified: true,
        abhaLinkedAt: new Date(),
      },
    });

    // Also link ABHA ID on Patient record if present
    const patient = await prisma.patient.findFirst({
      where: {
        OR: [{ userId: req.user.id }, { phone: req.user.phone || undefined }],
      },
    });

    if (patient) {
      await prisma.patient.update({
        where: { id: patient.id },
        data: { abhaId: cleanAbha },
      });
    }

    return res.status(200).json({
      message: "ABHA ID identity verified and linked successfully",
      abhaId: updatedUser.abhaId,
      abhaVerified: updatedUser.abhaVerified,
      abhaLinkedAt: updatedUser.abhaLinkedAt,
    });
  } catch (err) {
    console.error("Error in linkAbhaId:", err);
    return res.status(500).json({ error: "Failed to link ABHA ID", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 2. NEARBY FACILITY LOCATOR (Vacant beds, X-ray, ICU, Required Medicine)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/patient/facilities/search
 * Search & locate nearby health facilities filtered by available beds, X-ray, ICU, and medicine stock
 */
async function locateNearbyFacilities(req, res) {
  try {
    const {
      district,
      taluka,
      hasBeds,
      minBeds,
      hasXray,
      hasIcu,
      medicineName,
      reqService,
    } = req.query;

    const whereClause = {
      isActive: true,
    };

    if (district) {
      whereClause.district = { contains: String(district).trim(), mode: "insensitive" };
    }
    if (taluka) {
      whereClause.taluka = { contains: String(taluka).trim(), mode: "insensitive" };
    }

    if (minBeds) {
      whereClause.bedsAvailable = { gte: Number(minBeds) };
    } else if (hasBeds === "true") {
      whereClause.bedsAvailable = { gt: 0 };
    }

    if (hasXray === "true") {
      whereClause.xrayStatus = true;
    }

    if (hasIcu === "true") {
      whereClause.icuAvailable = true;
    }

    if (reqService) {
      const serviceUpper = String(reqService).toUpperCase();
      if (serviceUpper === "XRAY") whereClause.xrayStatus = true;
      if (serviceUpper === "ICU") whereClause.icuAvailable = true;
      if (serviceUpper === "GYNAC" || serviceUpper === "ORTHO" || serviceUpper === "PEDIATRIC") {
        whereClause.hasSpecialist = true;
        whereClause.specialistTypes = { has: serviceUpper };
      }
    }

    if (medicineName) {
      whereClause.inventory = {
        some: {
          medicineName: { contains: String(medicineName).trim(), mode: "insensitive" },
          currentStock: { gt: 0 },
        },
      };
    }

    const facilities = await prisma.facility.findMany({
      where: whereClause,
      include: {
        inventory: medicineName
          ? {
              where: {
                medicineName: { contains: String(medicineName).trim(), mode: "insensitive" },
                currentStock: { gt: 0 },
              },
            }
          : false,
      },
      orderBy: [{ bedsAvailable: "desc" }, { name: "asc" }],
      take: 20,
    });

    const results = facilities.map((f) => ({
      id: f.id,
      facilityCode: f.facilityCode,
      name: f.name,
      type: f.type,
      district: f.district,
      taluka: f.taluka,
      village: f.village,
      latitude: f.latitude,
      longitude: f.longitude,
      contactNumber: f.contactNumber,
      resources: {
        bedsTotal: f.bedsTotal,
        bedsAvailable: f.bedsAvailable,
        xrayAvailable: f.xrayStatus,
        icuAvailable: f.icuAvailable,
        hasSpecialist: f.hasSpecialist,
        specialistTypes: f.specialistTypes,
      },
      matchedMedicine: f.inventory ? f.inventory : undefined,
    }));

    return res.status(200).json({
      count: results.length,
      filters: { district, taluka, hasBeds, minBeds, hasXray, hasIcu, medicineName, reqService },
      facilities: results,
    });
  } catch (err) {
    console.error("Error in locateNearbyFacilities:", err);
    return res.status(500).json({ error: "Failed to search nearby facilities", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 3. EMERGENCY SOS REQUEST (One-tap & SMS Fallback)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/patient/sos
 * Trigger one-tap emergency SOS alert. Dispatches referral & generates 2G SMS fallback format
 */
async function triggerEmergencySos(req, res) {
  try {
    const { latitude, longitude, vitalBp, vitalSpo2, channel } = req.body;

    const phone = req.user?.phone || req.body.phone || "+919999999999";
    const cleanPhone = String(phone).trim();

    // Find closest available higher facility in district or first active CHC/District Hospital
    const nearestFacility = await prisma.facility.findFirst({
      where: {
        isActive: true,
        type: { in: ["CHC", "RURAL_HOSPITAL", "DISTRICT_HOSPITAL"] },
      },
      orderBy: { bedsAvailable: "desc" },
    });

    const sosAlert = await prisma.emergencySos.create({
      data: {
        userId: req.user?.id || null,
        phone: cleanPhone,
        latitude: latitude ? Number(latitude) : null,
        longitude: longitude ? Number(longitude) : null,
        vitalBp: vitalBp ? String(vitalBp).trim() : "140/90",
        vitalSpo2: vitalSpo2 ? Number(vitalSpo2) : 94,
        channel: channel || "APP",
        status: "ACTIVE",
        facilityId: nearestFacility ? nearestFacility.id : null,
      },
    });

    // Create an emergency referral if patient profile exists
    let patient = await prisma.patient.findFirst({
      where: { OR: [{ userId: req.user?.id }, { phone: cleanPhone }] },
    });

    let emergencyReferral = null;
    if (patient && nearestFacility) {
      emergencyReferral = await prisma.referral.create({
        data: {
          patientId: patient.id,
          sourceFacilityId: patient.facilityId || nearestFacility.id,
          destFacilityId: nearestFacility.id,
          reqService: "EMERGENCY_ICU_AMBULANCE",
          status: "PENDING",
          notes: `[EMERGENCY SOS ALERT] BP: ${sosAlert.vitalBp}, SpO2: ${sosAlert.vitalSpo2}%`,
        },
      });
    }

    // Generate pipe-separated 2G SMS fallback string format for offline/2G bypass
    // Format: EMG|<PHONE>|<BP>|<SPO2>
    const smsFallbackPayload = `EMG|${cleanPhone}|${sosAlert.vitalBp}|${sosAlert.vitalSpo2}`;

    return res.status(201).json({
      message: "EMERGENCY SOS ALERT DISPATCHED SUCCESSFULLY",
      sosId: sosAlert.id,
      status: sosAlert.status,
      emergencyContacts: ["108 (Maharashtra Ambulance)", "102 (Maternal Emergency)", "104 (Health Helpline)"],
      nearestFacility: nearestFacility
        ? {
            id: nearestFacility.id,
            name: nearestFacility.name,
            type: nearestFacility.type,
            contactNumber: nearestFacility.contactNumber,
            bedsAvailable: nearestFacility.bedsAvailable,
          }
        : null,
      emergencyReferralId: emergencyReferral ? emergencyReferral.id : null,
      smsFallbackPayload,
    });
  } catch (err) {
    console.error("Error in triggerEmergencySos:", err);
    return res.status(500).json({ error: "Failed to trigger emergency SOS", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 4. APPOINTMENT BOOKING & TELECONSULTATION
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/patient/appointments
 * Book in-person visit or request teleconsultation
 */
async function bookAppointment(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const { facilityId, type, scheduledAt, reason } = req.body;

    if (!facilityId || !scheduledAt) {
      return res.status(400).json({ error: "facilityId and scheduledAt are required" });
    }

    const facility = await prisma.facility.findUnique({ where: { id: facilityId } });
    if (!facility) {
      return res.status(404).json({ error: "Facility not found" });
    }

    const appointmentType = type && String(type).toUpperCase() === "TELECONSULTATION" ? "TELECONSULTATION" : "IN_PERSON";
    
    // Generate video teleconsultation room link if requested
    const meetingLink = appointmentType === "TELECONSULTATION"
      ? `https://teleconsult.ruralhealth.gov.in/room/room-${uuidv4().slice(0, 8)}`
      : null;

    const patient = await prisma.patient.findFirst({
      where: { OR: [{ userId: req.user.id }, { phone: req.user.phone || undefined }] },
    });

    const appointment = await prisma.appointment.create({
      data: {
        userId: req.user.id,
        patientId: patient ? patient.id : null,
        facilityId: facility.id,
        type: appointmentType,
        scheduledAt: new Date(scheduledAt),
        status: "REQUESTED",
        reason: reason ? String(reason).trim() : "General Consultation",
        meetingLink,
      },
      include: {
        facility: {
          select: { name: true, type: true, district: true, taluka: true, contactNumber: true },
        },
      },
    });

    return res.status(201).json({
      message: `${appointmentType === "TELECONSULTATION" ? "Teleconsultation" : "In-Person Visit"} requested successfully`,
      appointment,
    });
  } catch (err) {
    console.error("Error in bookAppointment:", err);
    return res.status(500).json({ error: "Failed to book appointment", detail: err.message });
  }
}

/**
 * GET /api/v1/patient/appointments
 * List upcoming and past appointments for logged-in citizen
 */
async function getAppointments(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const appointments = await prisma.appointment.findMany({
      where: { userId: req.user.id },
      include: {
        facility: {
          select: { id: true, name: true, type: true, district: true, taluka: true, contactNumber: true },
        },
      },
      orderBy: { scheduledAt: "asc" },
    });

    return res.status(200).json({
      count: appointments.length,
      appointments,
    });
  } catch (err) {
    console.error("Error in getAppointments:", err);
    return res.status(500).json({ error: "Failed to fetch appointments", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 5. LONGITUDINAL HEALTH RECORD ACCESS
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/patient/health-records
 * View own longitudinal health records (triage visits, vitals, prescriptions, diagnoses)
 */
async function getHealthRecords(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const patient = await prisma.patient.findFirst({
      where: {
        OR: [{ userId: req.user.id }, { phone: req.user.phone || undefined }],
      },
      include: {
        facility: { select: { name: true, type: true, district: true } },
        triageRecords: {
          include: { facility: { select: { name: true, type: true } } },
          orderBy: { recordedAt: "desc" },
        },
        referrals: {
          include: {
            sourceFacility: { select: { name: true, type: true } },
            destFacility: { select: { name: true, type: true } },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!patient) {
      return res.status(200).json({
        message: "No health records found yet for this patient account",
        patientProfile: null,
        totalVisits: 0,
        triageHistory: [],
        referralHistory: [],
      });
    }

    // Extract vitals timeline
    const vitalsTimeline = patient.triageRecords.map((t) => ({
      visitId: t.id,
      recordedAt: t.recordedAt,
      recordedBy: t.recordedBy || "ASHA Worker",
      facilityName: t.facility.name,
      riskLevel: t.riskLevel,
      symptoms: t.symptoms,
      vitals: t.vitals,
      notes: t.notes,
    }));

    return res.status(200).json({
      patientProfile: {
        id: patient.id,
        name: patient.name,
        age: patient.age,
        gender: patient.gender,
        phone: patient.phone,
        village: patient.village,
        abhaId: patient.abhaId || req.user.abhaId,
        abhaVerified: req.user.abhaVerified,
        primaryFacility: patient.facility ? patient.facility.name : "Sub Centre",
      },
      totalVisits: patient.triageRecords.length,
      triageHistory: vitalsTimeline,
      referralHistory: patient.referrals,
    });
  } catch (err) {
    console.error("Error in getHealthRecords:", err);
    return res.status(500).json({ error: "Failed to fetch health records", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 6. REAL-TIME REFERRAL TRACKING
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/patient/referrals
 * Track referral status progression (e.g. "Sent to District Hospital – Accepted")
 */
async function trackReferrals(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const patient = await prisma.patient.findFirst({
      where: { OR: [{ userId: req.user.id }, { phone: req.user.phone || undefined }] },
    });

    if (!patient) {
      return res.status(200).json({ count: 0, referrals: [] });
    }

    const referrals = await prisma.referral.findMany({
      where: { patientId: patient.id },
      include: {
        sourceFacility: { select: { id: true, name: true, type: true, district: true, contactNumber: true } },
        destFacility: { select: { id: true, name: true, type: true, district: true, contactNumber: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const formatted = referrals.map((ref) => {
      const destName = ref.destFacility ? ref.destFacility.name : "Higher Health Centre";
      let statusDisplay = "";

      switch (ref.status) {
        case "PENDING":
          statusDisplay = `Sent to ${destName} – Pending Review`;
          break;
        case "ACCEPTED":
          statusDisplay = `Sent to ${destName} – Accepted`;
          break;
        case "IN_TRANSIT":
          statusDisplay = `In Transit to ${destName}`;
          break;
        case "COMPLETED":
          statusDisplay = `Care Received at ${destName} – Completed`;
          break;
        case "REJECTED":
          statusDisplay = `Referral to ${destName} – Rejected / Rerouting Required`;
          break;
        default:
          statusDisplay = `Referral Status: ${ref.status}`;
      }

      return {
        id: ref.id,
        reqService: ref.reqService,
        status: ref.status,
        statusDisplay,
        notes: ref.notes,
        sourceFacility: ref.sourceFacility,
        destFacility: ref.destFacility,
        createdAt: ref.createdAt,
        updatedAt: ref.updatedAt,
      };
    });

    return res.status(200).json({
      count: formatted.length,
      referrals: formatted,
    });
  } catch (err) {
    console.error("Error in trackReferrals:", err);
    return res.status(500).json({ error: "Failed to track referrals", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 7. CHAT WITH ASSIGNED ASHA / DOCTOR
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/patient/chat/send
 * Send a chat message to assigned ASHA worker or doctor
 */
async function sendChatMessage(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const { receiverId, message } = req.body;

    if (!receiverId || !message) {
      return res.status(400).json({ error: "receiverId and message text are required" });
    }

    const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
    if (!receiver) {
      return res.status(404).json({ error: "Recipient user not found" });
    }

    const chatMessage = await prisma.chatMessage.create({
      data: {
        senderId: req.user.id,
        receiverId: receiver.id,
        message: String(message).trim(),
      },
      include: {
        sender: { select: { id: true, name: true, role: true } },
        receiver: { select: { id: true, name: true, role: true } },
      },
    });

    return res.status(201).json({
      message: "Message sent successfully",
      chatMessage,
    });
  } catch (err) {
    console.error("Error in sendChatMessage:", err);
    return res.status(500).json({ error: "Failed to send chat message", detail: err.message });
  }
}

/**
 * GET /api/v1/patient/chat/messages
 * Get chat message history thread between logged-in patient and ASHA/doctor
 */
async function getChatHistory(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const { recipientId } = req.query;

    const whereClause = recipientId
      ? {
          OR: [
            { senderId: req.user.id, receiverId: String(recipientId) },
            { senderId: String(recipientId), receiverId: req.user.id },
          ],
        }
      : {
          OR: [{ senderId: req.user.id }, { receiverId: req.user.id }],
        };

    const messages = await prisma.chatMessage.findMany({
      where: whereClause,
      include: {
        sender: { select: { id: true, name: true, role: true } },
        receiver: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return res.status(200).json({
      count: messages.length,
      messages,
    });
  } catch (err) {
    console.error("Error in getChatHistory:", err);
    return res.status(500).json({ error: "Failed to fetch chat history", detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// 8. POST-VISIT FEEDBACK & RATING
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/patient/feedback
 * Submit rating (1-5 stars) and feedback review post-visit
 */
async function submitFeedback(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const { facilityId, appointmentId, rating, comment } = req.body;

    if (!rating || Number(rating) < 1 || Number(rating) > 5) {
      return res.status(400).json({ error: "Rating is required and must be an integer between 1 and 5 stars" });
    }

    const feedback = await prisma.feedback.create({
      data: {
        userId: req.user.id,
        facilityId: facilityId ? String(facilityId) : null,
        appointmentId: appointmentId ? String(appointmentId) : null,
        rating: Number(rating),
        comment: comment ? String(comment).trim() : null,
      },
      include: {
        facility: { select: { name: true, type: true } },
      },
    });

    return res.status(201).json({
      message: "Thank you for your feedback! Your rating helps improve healthcare quality.",
      feedback,
    });
  } catch (err) {
    console.error("Error in submitFeedback:", err);
    return res.status(500).json({ error: "Failed to submit feedback", detail: err.message });
  }
}

/**
 * GET /api/v1/patient/feedback
 * View submitted feedback for logged-in citizen
 */
async function getFeedback(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    const feedbacks = await prisma.feedback.findMany({
      where: { userId: req.user.id },
      include: {
        facility: { select: { id: true, name: true, type: true } },
        appointment: { select: { id: true, type: true, scheduledAt: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({
      count: feedbacks.length,
      feedbacks,
    });
  } catch (err) {
    console.error("Error in getFeedback:", err);
    return res.status(500).json({ error: "Failed to fetch feedback history", detail: err.message });
  }
}

module.exports = {
  updateProfile,
  linkAbhaId,
  locateNearbyFacilities,
  triggerEmergencySos,
  bookAppointment,
  getAppointments,
  getHealthRecords,
  trackReferrals,
  sendChatMessage,
  getChatHistory,
  submitFeedback,
  getFeedback,
};
