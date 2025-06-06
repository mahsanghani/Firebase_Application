const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');

// Initialize Firestore and Storage
const firestore = new Firestore();
const storage = new Storage();
const BUCKET_NAME = 'internship-applications-files';

// Simple multipart parser - more reliable than Busboy for basic forms
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const boundary = req.headers['content-type']?.split('boundary=')[1];
    if (!boundary) {
      reject(new Error('No boundary found in multipart data'));
      return;
    }

    let body = '';
    const fields = {};
    const files = [];

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const parts = body.split(`--${boundary}`);
        
        for (const part of parts) {
          if (part.includes('Content-Disposition: form-data')) {
            const nameMatch = part.match(/name="([^"]+)"/);
            if (nameMatch) {
              const fieldName = nameMatch[1];
              
              // Check if it's a file
              if (part.includes('Content-Type:') && part.includes('filename=')) {
                const filenameMatch = part.match(/filename="([^"]+)"/);
                const contentTypeMatch = part.match(/Content-Type: ([^\r\n]+)/);
                
                if (filenameMatch && filenameMatch[1]) {
                  files.push({
                    fieldname: fieldName,
                    filename: filenameMatch[1],
                    contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
                    data: part.split('\r\n\r\n')[1]?.split(`\r\n--${boundary}`)[0] || ''
                  });
                }
              } else {
                // Regular field
                const value = part.split('\r\n\r\n')[1]?.split(`\r\n--${boundary}`)[0] || '';
                fields[fieldName] = value.trim();
              }
            }
          }
        }
        
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

functions.http('submitInternshipApplication', async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({
      success: false,
      error: 'Method Not Allowed',
      message: 'Only POST requests are allowed'
    });
    return;
  }

  try {
    console.log('Function started');
    console.log('Content-Type:', req.headers['content-type']);
    
    let applicationData = {};
    let uploadedFiles = [];

    // Handle different content types
    if (req.headers['content-type']?.includes('multipart/form-data')) {
      console.log('Processing multipart form data with simple parser');
      
      try {
        const { fields, files } = await parseMultipart(req);
        applicationData = fields;
        
        console.log('Parsed fields:', Object.keys(fields));
        console.log('Parsed files:', files.map(f => f.filename));
        
        // Handle file uploads to Cloud Storage
        if (files.length > 0) {
          const applicationId = `APP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          for (const file of files) {
            if (file.filename && file.data) {
              try {
                const destination = `applications/${applicationId}/${file.filename}`;
                const bucket = storage.bucket(BUCKET_NAME);
                const gcsFile = bucket.file(destination);
                
                // Convert data to buffer and upload
                const buffer = Buffer.from(file.data, 'binary');
                await gcsFile.save(buffer, {
                  metadata: {
                    contentType: file.contentType,
                  },
                });
                
                uploadedFiles.push({
                  fieldname: file.fieldname,
                  filename: file.filename,
                  gcsPath: `gs://${BUCKET_NAME}/${destination}`,
                  publicUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`
                });
                
                console.log(`Uploaded file: ${file.filename}`);
              } catch (uploadError) {
                console.error('File upload error:', uploadError);
              }
            }
          }
        }
        
      } catch (parseError) {
        console.error('Error parsing multipart data:', parseError);
        // Fallback: try to get data from req.body if available
        if (req.body) {
          applicationData = req.body;
        }
      }
    } else if (req.headers['content-type']?.includes('application/json')) {
      console.log('Processing JSON data');
      applicationData = req.body || {};
    } else {
      console.log('Processing URL-encoded data');
      applicationData = req.body || {};
    }

    console.log('Final application data keys:', Object.keys(applicationData));

    // Generate unique application ID
    const applicationId = uploadedFiles.length > 0 ? 
      uploadedFiles[0].gcsPath.split('/')[1] : // Use existing ID if files were uploaded
      `APP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Prepare data for Firestore
    const firestoreData = {
      applicationId,
      personalInfo: {
        firstName: applicationData.firstName || '',
        lastName: applicationData.lastName || '',
        email: applicationData.email || '',
        phone: applicationData.phone || '',
        address: applicationData.address || ''
      },
      education: {
        university: applicationData.university || '',
        major: applicationData.major || '',
        graduationDate: applicationData.graduationDate || '',
        gpa: applicationData.gpa ? parseFloat(applicationData.gpa) : null
      },
      internshipDetails: {
        position: applicationData.position || '',
        availability: applicationData.availability || '',
        duration: applicationData.duration ? parseInt(applicationData.duration) : null,
        workType: applicationData.workType || ''
      },
      skillsAndExperience: {
        skills: applicationData.skills || '',
        experience: applicationData.experience || '',
        projects: applicationData.projects || ''
      },
      additionalInfo: {
        motivation: applicationData.motivation || '',
        goals: applicationData.goals || '',
        additionalInfo: applicationData.additionalInfo || ''
      },
      files: uploadedFiles,
      agreements: {
        terms: applicationData.terms === 'true' || applicationData.terms === true,
        newsletter: applicationData.newsletter === 'true' || applicationData.newsletter === true
      },
      metadata: {
        submittedAt: new Date(),
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent') || 'unknown',
        contentType: req.headers['content-type'] || 'unknown'
      }
    };

    // Validate required fields
    const requiredFields = ['firstName', 'lastName', 'email', 'phone', 'university', 'major', 'graduationDate', 'position', 'availability', 'motivation'];
    const missingFields = requiredFields.filter(field => !applicationData[field] || applicationData[field].trim() === '');
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: `Missing required fields: ${missingFields.join(', ')}`,
        missingFields,
        receivedFields: Object.keys(applicationData)
      });
    }

    if (applicationData.terms !== 'true' && applicationData.terms !== true) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Terms and conditions must be accepted'
      });
    }

    console.log('Saving to Firestore...');
    
    // Save to Firestore
    await firestore.collection('internship-applications').doc(applicationId).set(firestoreData);
    
    console.log('Successfully saved to Firestore');

    // Send success response
    res.status(200).json({
      success: true,
      applicationId,
      message: 'Application submitted successfully',
      filesUploaded: uploadedFiles.length,
      fieldsReceived: Object.keys(applicationData),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error processing application:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to process application',
      details: error.message
    });
  }
});
