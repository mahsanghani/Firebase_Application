const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const multer = require('multer');

// Initialize services once (global scope for reuse)
const firestore = new Firestore();
const storage = new Storage();
const BUCKET_NAME = 'internship-applications-files';

// Pre-compile validation rules
const REQUIRED_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'university', 'major', 'graduationDate', 'position', 'availability', 'motivation', 'terms'];

// Fast multer configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 5
  }
});

const uploadFields = upload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'coverLetter', maxCount: 1 },
  { name: 'portfolio', maxCount: 3 }
]);

functions.http('submitInternshipApplication', async (req, res) => {
  const startTime = Date.now();
  
  // Fast CORS
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
    console.log('Processing request...');
    console.log('Content-Type:', req.headers['content-type']);

    let applicationData = {};
    let files = [];

    // Handle different content types
    if (req.headers['content-type']?.includes('multipart/form-data')) {
      console.log('Processing multipart with multer');
      
      // Process multer in parallel with response preparation
      await new Promise((resolve, reject) => {
        uploadFields(req, res, (err) => {
          if (err) {
            console.error('Multer error:', err);
            reject(err);
          } else {
            resolve();
          }
        });
      });

      applicationData = req.body || {};
      
      // Extract file info quickly
      if (req.files) {
        for (const [fieldName, fileList] of Object.entries(req.files)) {
          for (const file of fileList) {
            files.push({
              fieldname: fieldName,
              filename: file.originalname,
              buffer: file.buffer,
              mimetype: file.mimetype,
              size: file.size
            });
          }
        }
      }
    } else {
      // JSON/URL-encoded
      applicationData = req.body || {};
    }

    console.log('Data received - Fields:', Object.keys(applicationData).length, 'Files:', files.length);

    // Fast validation
    const missing = REQUIRED_FIELDS.filter(field => {
      if (field === 'terms') return applicationData[field] !== 'true' && applicationData[field] !== true;
      return !applicationData[field] || applicationData[field].toString().trim() === '';
    });
    
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        missing,
        received: Object.keys(applicationData),
        duration: Date.now() - startTime
      });
    }

    // Generate ID
    const applicationId = `APP_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Prepare minimal data structure for immediate response
    const doc = {
      id: applicationId,
      personal: {
        firstName: applicationData.firstName,
        lastName: applicationData.lastName,
        email: applicationData.email,
        phone: applicationData.phone,
        address: applicationData.address || ''
      },
      education: {
        university: applicationData.university,
        major: applicationData.major,
        graduation: applicationData.graduationDate,
        gpa: applicationData.gpa ? parseFloat(applicationData.gpa) : null
      },
      internship: {
        position: applicationData.position,
        availability: applicationData.availability,
        duration: applicationData.duration ? parseInt(applicationData.duration) : null,
        workType: applicationData.workType || 'remote'
      },
      content: {
        motivation: applicationData.motivation,
        skills: applicationData.skills || '',
        experience: applicationData.experience || '',
        projects: applicationData.projects || '',
        goals: applicationData.goals || '',
        additional: applicationData.additionalInfo || ''
      },
      files: [], // Will be updated after upload
      meta: {
        submitted: new Date(),
        terms: true,
        newsletter: applicationData.newsletter === 'true' || applicationData.newsletter === true,
        ip: req.ip || 'unknown',
        agent: req.get('User-Agent')?.substr(0, 100) || 'unknown',
        fileCount: files.length
      }
    };

    // Respond immediately - don't wait for file uploads or database
    const responseTime = Date.now() - startTime;
    console.log(`Sending response after ${responseTime}ms`);
    
    res.status(200).json({
      success: true,
      applicationId,
      message: 'Application received and processing',
      filesReceived: files.length,
      fileNames: files.map(f => f.filename),
      duration: responseTime
    });

    // Process files and save to database in background
    console.log('Starting background processing...');
    
    try {
      const uploadedFiles = [];
      
      // Upload files in parallel if any exist
      if (files.length > 0) {
        console.log(`Uploading ${files.length} files...`);
        
        const uploadPromises = files.map(async (file) => {
          try {
            const destination = `applications/${applicationId}/${file.filename}`;
            const gcsFile = storage.bucket(BUCKET_NAME).file(destination);
            
            await gcsFile.save(file.buffer, {
              metadata: {
                contentType: file.mimetype,
              },
            });
            
            return {
              fieldname: file.fieldname,
              filename: file.filename,
              gcsPath: `gs://${BUCKET_NAME}/${destination}`,
              publicUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`,
              size: file.size
            };
          } catch (uploadError) {
            console.error(`Upload error for ${file.filename}:`, uploadError);
            return null; // Continue with other files
          }
        });

        const results = await Promise.allSettled(uploadPromises);
        uploadedFiles.push(...results
          .filter(result => result.status === 'fulfilled' && result.value)
          .map(result => result.value)
        );
        
        console.log(`Successfully uploaded ${uploadedFiles.length}/${files.length} files`);
      }

      // Update document with file info
      doc.files = uploadedFiles;
      
      // Save to Firestore
      await firestore.collection('applications').doc(applicationId).set(doc);
      console.log(`Database save completed for ${applicationId}`);
      
      // Optional: Send notification email here
      
    } catch (backgroundError) {
      console.error('Background processing error:', backgroundError);
      
      // Save basic data without files as fallback
      try {
        await firestore.collection('applications').doc(applicationId).set({
          ...doc,
          files: [],
          meta: {
            ...doc.meta,
            processingError: backgroundError.message,
            fallbackSave: true
          }
        });
        console.log(`Fallback save completed for ${applicationId}`);
      } catch (fallbackError) {
        console.error('Fallback save failed:', fallbackError);
      }
    }

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('Function error:', error);
    
    res.status(500).json({
      success: false,
      error: 'Processing failed',
      message: error.message,
      duration
    });
  }
});
