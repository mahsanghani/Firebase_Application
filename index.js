const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');

// Initialize services
const firestore = new Firestore();
const storage = new Storage();
const BUCKET_NAME = 'internship-applications-files';

// Validation rules
const REQUIRED_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'university', 'major', 'graduationDate', 'position', 'availability', 'motivation', 'terms'];

functions.http('submitInternshipApplication', async (req, res) => {
  const startTime = Date.now();
  
  // CORS headers
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
    console.log('Content-Length:', req.headers['content-length']);

    let applicationData = {};
    let processingMethod = 'unknown';
    const contentType = req.headers['content-type'] || '';
    
    // ONLY handle JSON - reject multipart with helpful message
    if (contentType.includes('multipart/form-data')) {
      console.log('Multipart detected - redirecting to JSON approach');
      
      return res.status(400).json({
        success: false,
        error: 'Multipart not supported',
        message: 'Please submit form data as JSON. File uploads available separately.',
        instruction: 'Use Content-Type: application/json and send form fields in JSON format',
        fileUploadInfo: 'Files can be uploaded after form submission using the uploadApplicationFiles endpoint',
        duration: Date.now() - startTime
      });
      
    } else if (contentType.includes('application/json')) {
      processingMethod = 'json';
      console.log('Processing JSON data');
      applicationData = req.body || {};
      
    } else {
      processingMethod = 'urlencoded';
      console.log('Processing URL-encoded data');
      applicationData = req.body || {};
    }

    console.log(`Processing method: ${processingMethod}`);
    console.log('Fields received:', Object.keys(applicationData));

    // Validate required fields
    const missing = REQUIRED_FIELDS.filter(field => {
      if (field === 'terms') return applicationData[field] !== 'true' && applicationData[field] !== true;
      return !applicationData[field] || applicationData[field].toString().trim() === '';
    });
    
    if (missing.length > 0) {
      console.log('Validation failed - missing fields:', missing);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        missing,
        received: Object.keys(applicationData),
        method: processingMethod,
        duration: Date.now() - startTime
      });
    }

    // Generate application ID
    const applicationId = `APP_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Prepare document structure
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
      files: [], // Will be added via separate endpoint
      meta: {
        submitted: new Date(),
        terms: true,
        newsletter: applicationData.newsletter === 'true' || applicationData.newsletter === true,
        ip: req.ip || 'unknown',
        agent: req.get('User-Agent')?.substr(0, 100) || 'unknown',
        processingMethod
      }
    };

    // Respond immediately - always fast
    const responseTime = Date.now() - startTime;
    console.log(`Sending response after ${responseTime}ms`);
    
    res.status(200).json({
      success: true,
      applicationId,
      message: 'Application submitted successfully',
      note: 'Form data saved. Upload files separately if needed.',
      fileUploadEndpoint: 'uploadApplicationFiles',
      duration: responseTime
    });

    // Save to database in background
    try {
      await firestore.collection('applications').doc(applicationId).set(doc);
      console.log(`Database save completed for ${applicationId}`);
    } catch (dbError) {
      console.error('Database save error:', dbError);
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

// Separate file upload function
functions.http('uploadApplicationFiles', async (req, res) => {
  // CORS
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    console.log('File upload request received');
    
    // Expect JSON with base64 encoded files
    const { applicationId, files } = req.body;
    
    if (!applicationId) {
      return res.status(400).json({
        success: false,
        error: 'Missing application ID'
      });
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files provided',
        expectedFormat: 'Array of {filename, content, contentType, fieldname} objects with base64 content'
      });
    }

    console.log(`Processing ${files.length} files for application ${applicationId}`);

    const uploadedFiles = [];
    
    for (const fileData of files) {
      try {
        const { filename, content, contentType, fieldname } = fileData;
        
        if (!filename || !content) {
          console.warn('Skipping invalid file data:', { filename, hasContent: !!content });
          continue;
        }

        // Decode base64 content
        const buffer = Buffer.from(content, 'base64');
        
        // Upload to GCS
        const destination = `applications/${applicationId}/${filename}`;
        const gcsFile = storage.bucket(BUCKET_NAME).file(destination);
        
        await gcsFile.save(buffer, {
          metadata: {
            contentType: contentType || 'application/octet-stream',
          },
        });
        
        uploadedFiles.push({
          fieldname: fieldname || 'file',
          filename,
          gcsPath: `gs://${BUCKET_NAME}/${destination}`,
          publicUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`,
          size: buffer.length
        });
        
        console.log(`Uploaded: ${filename} (${buffer.length} bytes)`);
        
      } catch (uploadError) {
        console.error(`Upload failed for file:`, uploadError);
      }
    }

    // Update application in Firestore
    try {
      const docRef = firestore.collection('applications').doc(applicationId);
      await docRef.update({
        files: uploadedFiles,
        'meta.filesUpdated': new Date()
      });
      console.log(`Updated application ${applicationId} with ${uploadedFiles.length} files`);
    } catch (updateError) {
      console.error('Failed to update application:', updateError);
    }

    res.status(200).json({
      success: true,
      applicationId,
      filesUploaded: uploadedFiles.length,
      files: uploadedFiles.map(f => ({ name: f.filename, size: f.size }))
    });

  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Upload failed',
      message: error.message
    });
  }
});
