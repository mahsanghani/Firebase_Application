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

// Configure multer with more permissive settings
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 10, // Increased file limit
    fieldSize: 2 * 1024 * 1024, // 2MB for form fields
    fieldNameSize: 100, // Field name size
    fields: 50, // Max number of fields
    parts: 100 // Max form parts
  },
  fileFilter: (req, file, cb) => {
    console.log('File filter - Processing file:', file.originalname, file.mimetype, file.fieldname);
    // Accept all files
    cb(null, true);
  }
});

// Use .any() instead of .fields() to be more permissive
const uploadAny = upload.any();

// Better multer wrapper with detailed logging
function handleMultipart(req, res) {
  return new Promise((resolve, reject) => {
    console.log('Starting multer processing...');
    console.log('Request headers:', {
      'content-type': req.headers['content-type'],
      'content-length': req.headers['content-length']
    });

    uploadAny(req, res, (err) => {
      if (err) {
        console.error('Multer error details:', {
          message: err.message,
          code: err.code,
          field: err.field,
          storageErrors: err.storageErrors,
          stack: err.stack
        });
        
        // More specific error handling
        if (err.code === 'LIMIT_FILE_SIZE') {
          reject(new Error('File too large (max 10MB per file)'));
        } else if (err.code === 'LIMIT_FILE_COUNT') {
          reject(new Error('Too many files (max 10 files)'));
        } else if (err.code === 'LIMIT_FIELD_COUNT') {
          reject(new Error('Too many form fields'));
        } else if (err.code === 'LIMIT_PART_COUNT') {
          reject(new Error('Form too complex'));
        } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          reject(new Error('Unexpected file field'));
        } else if (err.message && err.message.includes('Unexpected end of form')) {
          reject(new Error('Form data corrupted - please try again'));
        } else if (err.message && err.message.includes('Part terminated early')) {
          reject(new Error('File upload interrupted - please try again'));
        } else {
          reject(new Error(`Upload error: ${err.message || 'Unknown multer error'}`));
        }
      } else {
        console.log('Multer processing completed successfully');
        console.log('Form fields received:', Object.keys(req.body || {}));
        console.log('Files received:', req.files ? req.files.length : 0);
        if (req.files) {
          req.files.forEach((file, index) => {
            console.log(`File ${index + 1}: ${file.originalname} (${file.size} bytes, ${file.mimetype})`);
          });
        }
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
    console.log('User-Agent:', req.headers['user-agent']);

    let applicationData = {};
    let files = [];
    let processingMethod = 'unknown';

    // Detect content type and handle accordingly
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      processingMethod = 'multipart';
      console.log('Attempting multipart processing...');
      
      try {
        // Process multipart data with timeout and better error handling
        await Promise.race([
          handleMultipart(req, res),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Multipart processing timeout (10s)')), 10000)
          )
        ]);
        
        // Extract form data
        applicationData = req.body || {};
        console.log('Multipart form data:', Object.keys(applicationData));
        
        // Extract files using multer's .any() approach
        if (req.files && Array.isArray(req.files)) {
          console.log(`Processing ${req.files.length} uploaded files`);
          
          files = req.files.map(file => ({
            fieldname: file.fieldname,
            filename: file.originalname,
            buffer: file.buffer,
            mimetype: file.mimetype,
            size: file.size
          }));
          
          console.log('Files processed:', files.map(f => `${f.filename} (${f.size} bytes)`));
        }
        
        console.log(`Multipart processing successful: ${Object.keys(applicationData).length} fields, ${files.length} files`);
        
      } catch (multipartError) {
        console.error('Multipart processing failed:', multipartError.message);
        console.error('Error stack:', multipartError.stack);
        
        // Return detailed error for debugging
        return res.status(400).json({
          success: false,
          error: 'Multipart form error',
          message: multipartError.message,
          suggestion: 'Try reducing file size or number of files, or submit without files',
          contentType: contentType,
          contentLength: req.headers['content-length'],
          duration: Date.now() - startTime
        });
      }
      
    } else if (contentType.includes('application/json')) {
      processingMethod = 'json';
      console.log('Processing JSON data');
      applicationData = req.body || {};
      
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      processingMethod = 'urlencoded';
      console.log('Processing URL-encoded data');
      applicationData = req.body || {};
      
    } else {
      console.log('Unknown content type, treating as JSON');
      processingMethod = 'unknown';
      applicationData = req.body || {};
    }

    console.log(`Processing method: ${processingMethod}`);
    console.log('Final data - Fields:', Object.keys(applicationData).length, 'Files:', files.length);

    // Debug: log all received field names
    console.log('Received field names:', Object.keys(applicationData));

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
        receivedValues: applicationData, // For debugging
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
              resumable: false // Use simple upload for files under 5MB
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
            // Continue with other files
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
    console.error('Error stack:', error.stack);
    
    res.status(500).json({
      success: false,
      error: 'Processing failed',
      message: error.message,
      duration
    });
  }
});
