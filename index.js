const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');

// Initialize Firestore once (global scope for reuse)
const firestore = new Firestore();

// Pre-compile validation rules
const REQUIRED_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'university', 'major', 'graduationDate', 'position', 'availability', 'motivation', 'terms'];

functions.http('submitInternshipApplication', async (req, res) => {
  const startTime = Date.now();
  
  // Fast CORS handling
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache'
  });

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    console.log('Request started');
    
    // Quick data extraction
    const data = req.body || {};
    
    // Fast validation - fail early
    const missing = REQUIRED_FIELDS.filter(field => {
      if (field === 'terms') return data[field] !== 'true' && data[field] !== true;
      return !data[field] || data[field].toString().trim() === '';
    });
    
    if (missing.length > 0) {
      console.log('Validation failed:', missing);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        missing,
        duration: Date.now() - startTime
      });
    }

    // Generate ID quickly
    const applicationId = `APP_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Minimal data structure - only what's needed
    const doc = {
      id: applicationId,
      personal: {
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone
      },
      education: {
        university: data.university,
        major: data.major,
        graduation: data.graduationDate,
        gpa: data.gpa ? parseFloat(data.gpa) : null
      },
      internship: {
        position: data.position,
        availability: data.availability,
        duration: data.duration ? parseInt(data.duration) : null,
        workType: data.workType || 'remote'
      },
      content: {
        motivation: data.motivation,
        skills: data.skills || '',
        experience: data.experience || '',
        projects: data.projects || '',
        goals: data.goals || '',
        additional: data.additionalInfo || ''
      },
      meta: {
        submitted: new Date(),
        terms: true,
        newsletter: data.newsletter === 'true' || data.newsletter === true,
        ip: req.ip,
        agent: req.get('User-Agent')?.substr(0, 100) || 'unknown'
      }
    };

    console.log('Saving to Firestore...');
    
    // Fast Firestore write - no waiting for confirmation
    const writePromise = firestore.collection('applications').doc(applicationId).set(doc);
    
    // Don't wait for Firestore - respond immediately
    const duration = Date.now() - startTime;
    console.log(`Response sent in ${duration}ms`);
    
    res.status(200).json({
      success: true,
      applicationId,
      message: 'Application received',
      duration
    });

    // Let Firestore finish in background
    try {
      await writePromise;
      console.log(`Firestore write completed for ${applicationId}`);
    } catch (dbError) {
      console.error('Background Firestore error:', dbError);
      // Could send to error logging service here
    }

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('Function error:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Processing failed',
      duration
    });
  }
});
