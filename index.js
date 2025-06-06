const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const multer = require('multer');

// Initialize services
const firestore = new Firestore();
const storage = new Storage();
const BUCKET_NAME = 'internship-applications-files';

// Validation rules
const REQUIRED_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'university', 'major', 'graduationDate', 'position', 'availability', 'motivation', 'terms'];

// Configure multer with better error handling
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 5,
    fieldSize: 1024 * 1024, // 1MB for form fields
    parts: 20 // Max form parts
  },
  fileFilter: (req, file, cb) => {
    console.log('Processing file:', file.originalname, file.mimetype);
    cb(null, true);
  }
});

const uploadFields = upload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'coverLetter', maxCount: 1 },
  { name: 'portfolio', maxCount: 3 }
]);

// Promisified multer wrapper with better error handling
function handleMultipart(req, res) {
  return new Promise((resolve, reject) => {
    uploadFields(req, res, (err) => {
      if (err) {
        console.error('Multer error details:', {
          message: err.message,
          code: err.code,
          field: err.field,
          stack: err.stack
        });
        
        // Handle specific multer errors
        if (err.code === 'LIMIT_FILE_SIZE') {
          reject(new Error('File too large (max 10MB)'));
        } else if (err.code === 'LIMIT_FILE_COUNT') {
          reject(new Error('Too many files'));
        } else if (err.message.includes('Unexpected end of form')) {
          reject(new Error('Form data incomplete - try refreshing and submitting again'));
        } else {
          reject(new Error(`File upload error: ${err.message}`));
        }
      } else {
        console.log('Multer processing successful');
        resolve();
      }
    });
  });
}

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
    let files = [];
    let processingMethod = 'unknown';

    // Detect content type and handle accordingly
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      processingMethod = 'multipart';
      console.log('Attempting multipart processing...');
      
      try {
        // Try multipart processing with timeout
        await Promise.race([
          handleMultipart(req, res),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Multipart processing timeout')), 5000)
          )
        ]);
        
        applicationData = req.body || {};
        console.log('Multipart fields received:', Object.keys(applicationData));
        
        // Extract files
        if (req.files) {
          console.log('Files detected:', Object.keys(req.files));
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
        
        console.log(`Multipart processing successful: ${Object.keys(applicationData).length} fields, ${files.length} files`);
        
      } catch (multipartError) {
        console.error('Multipart processing failed:', multipartError.message);
        
        // Fallback: ask client to retry with JSON
        return res.status(400).json({
          success: false,
          error: 'Multipart form error',
          message: multipartError.message,
          suggestion: 'Please try submitting without files first, then upload files separately',
          duration: Date.now() - startTime
        });
      }
      
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
    console.log('Final data - Fields:', Object.keys(applicationData).length, 'Files:', files.length);

    // Validate required fields
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
      files: [],
      meta: {
        submitted: new Date(),
        terms: true,
        newsletter: applicationData.newsletter === 'true' || applicationData.newsletter === true,
        ip: req.ip || 'unknown',
        agent: req.get('User-Agent')?.substr(0, 100) || 'unknown',
        processingMethod,
        fileCount: files.length
      }
    };

    // Respond immediately
    const responseTime = Date.now() - startTime;
    console.log(`Sending response after ${responseTime}ms`);
    
    res.status(200).json({
      success: true,
      applicationId,
      message: files.length > 0 ? 'Application received, processing files...' : 'Application submitted successfully',
      filesReceived: files.length,
      fileNames: files.map(f => f.filename),
      processingMethod,
      duration: responseTime
    });

    // Background processing
    console.log('Starting background processing...');
    
    try {
      const uploadedFiles = [];
      
      // Process files if any
      if (files.length > 0) {
        console.log(`Processing ${files.length} files in background...`);
        
        for (const file of files) {
          try {
            const destination = `applications/${applicationId}/${file.filename}`;
            const gcsFile = storage.bucket(BUCKET_NAME).file(destination);
            
            await gcsFile.save(file.buffer, {
              metadata: {
                contentType: file.mimetype,
              },
              resumable: false // Use simple upload for small files
            });
            
            uploadedFiles.push({
              fieldname: file.fieldname,
              filename: file.filename,
              gcsPath: `gs://${BUCKET_NAME}/${destination}`,
              publicUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`,
              size: file.size
            });
            
            console.log(`Uploaded: ${file.filename} (${file.size} bytes)`);
            
          } catch (uploadError) {
            console.error(`Upload failed for ${file.filename}:`, uploadError);
          }
        }
        
        console.log(`File processing complete: ${uploadedFiles.length}/${files.length} successful`);
      }

      // Update document with files
      doc.files = uploadedFiles;
      
      // Save to Firestore
      await firestore.collection('applications').doc(applicationId).set(doc);
      console.log(`Database save completed for ${applicationId}`);
      
    } catch (backgroundError) {
      console.error('Background processing error:', backgroundError);
      
      // Fallback save without files
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
