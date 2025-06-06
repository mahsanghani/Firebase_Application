const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');

// Initialize services
const firestore = new Firestore();
const storage = new Storage();
const BUCKET_NAME = 'internship-applications-files';

// Validation rules
const REQUIRED_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'university', 'major', 'graduationDate', 'position', 'availability', 'motivation', 'terms'];

// Ultra-simple multipart parser with aggressive timeouts
function parseSimpleMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    
    if (!boundaryMatch) {
      reject(new Error('No boundary found'));
      return;
    }
    
    const boundary = boundaryMatch[1].replace(/"/g, '');
    console.log('Boundary:', boundary);
    
    let body = '';
    let dataReceived = false;
    
    // Set aggressive timeout
    const timeout = setTimeout(() => {
      console.error('Multipart parsing timeout - no data received in 5 seconds');
      reject(new Error('Data stream timeout'));
    }, 5000);
    
    req.on('data', (chunk) => {
      dataReceived = true;
      body += chunk.toString();
      
      // Prevent memory overflow
      if (body.length > 20 * 1024 * 1024) { // 20MB limit
        clearTimeout(timeout);
        reject(new Error('Request too large'));
      }
    });
    
    req.on('end', () => {
      clearTimeout(timeout);
      
      if (!dataReceived) {
        reject(new Error('No data received'));
        return;
      }
      
      try {
        console.log(`Received ${body.length} characters of multipart data`);
        
        // Simple boundary splitting
        const parts = body.split(`--${boundary}`);
        console.log(`Split into ${parts.length} parts`);
        
        const fields = {};
        const files = [];
        
        for (let i = 1; i < parts.length - 1; i++) { // Skip first empty and last boundary parts
          const part = parts[i];
          
          if (!part.includes('Content-Disposition')) continue;
          
          // Find name
          const nameMatch = part.match(/name="([^"]+)"/);
          if (!nameMatch) continue;
          
          const fieldName = nameMatch[1];
          
          // Check if it's a file
          const isFile = part.includes('filename="');
          
          if (isFile) {
            const filenameMatch = part.match(/filename="([^"]+)"/);
            if (filenameMatch && filenameMatch[1]) {
              // Extract file content (very basic)
              const contentStart = part.indexOf('\r\n\r\n');
              if (contentStart > -1) {
                const fileContent = part.substring(contentStart + 4);
                // Clean up trailing boundary markers
                const cleanContent = fileContent.replace(/\r\n$/, '');
                
                files.push({
                  fieldname: fieldName,
                  filename: filenameMatch[1],
                  buffer: Buffer.from(cleanContent, 'binary'),
                  mimetype: 'application/octet-stream',
                  size: cleanContent.length
                });
                
                console.log(`File found: ${filenameMatch[1]} (${cleanContent.length} bytes)`);
              }
            }
          } else {
            // Regular field
            const valueStart = part.indexOf('\r\n\r\n');
            if (valueStart > -1) {
              const value = part.substring(valueStart + 4).replace(/\r\n$/, '');
              fields[fieldName] = value;
              console.log(`Field: ${fieldName} = ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`);
            }
          }
        }
        
        console.log(`Parsing complete: ${Object.keys(fields).length} fields, ${files.length} files`);
        resolve({ fields, files });
        
      } catch (parseError) {
        console.error('Parsing error:', parseError);
        reject(parseError);
      }
    });
    
    req.on('error', (error) => {
      clearTimeout(timeout);
      console.error('Request stream error:', error);
      reject(error);
    });
    
    // Additional safety timeout
    setTimeout(() => {
      if (!dataReceived) {
        console.error('No data received after 3 seconds, rejecting');
        reject(new Error('No data stream started'));
      }
    }, 3000);
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
    console.log('=== REQUEST START ===');
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Content-Length:', req.headers['content-length']);
    console.log('Method:', req.method);

    let applicationData = {};
    let files = [];
    let processingMethod = 'unknown';

    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      processingMethod = 'simple-multipart';
      console.log('Attempting simple multipart parsing...');
      
      try {
        // Very short timeout for multipart
        const result = await Promise.race([
          parseSimpleMultipart(req),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Overall timeout (8s)')), 8000)
          )
        ]);
        
        applicationData = result.fields;
        files = result.files;
        
        console.log(`✅ Simple multipart successful: ${Object.keys(applicationData).length} fields, ${files.length} files`);
        
      } catch (multipartError) {
        console.error('❌ Simple multipart failed:', multipartError.message);
        
        // Immediate fallback to JSON-only mode
        return res.status(400).json({
          success: false,
          error: 'Multipart not supported',
          message: `Multipart parsing failed: ${multipartError.message}`,
          suggestion: 'Please use JSON format (no file uploads)',
          fallbackUrl: 'Submit form without files',
          duration: Date.now() - startTime
        });
      }
      
    } else if (contentType.includes('application/json')) {
      processingMethod = 'json';
      console.log('Processing JSON data');
      applicationData = req.body || {};
      
    } else {
      processingMethod = 'other';
      console.log('Processing other format');
      applicationData = req.body || {};
    }

    console.log(`Processing method: ${processingMethod}`);
    console.log('Fields received:', Object.keys(applicationData));

    // Quick validation
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
        values: applicationData, // Debug info
        duration: Date.now() - startTime
      });
    }

    // Generate ID and respond immediately
    const applicationId = `APP_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const responseTime = Date.now() - startTime;
    
    console.log(`✅ Sending success response after ${responseTime}ms`);
    
    res.status(200).json({
      success: true,
      applicationId,
      message: files.length > 0 ? `Application submitted with ${files.length} files` : 'Application submitted successfully',
      filesReceived: files.length,
      fileNames: files.map(f => f.filename),
      processingMethod,
      duration: responseTime
    });

    // Background save (simplified)
    console.log('=== BACKGROUND PROCESSING ===');
    
    try {
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

      // Handle file uploads if any
      if (files.length > 0) {
        console.log(`Processing ${files.length} files...`);
        const uploadedFiles = [];
        
        for (const file of files) {
          try {
            const destination = `applications/${applicationId}/${file.filename}`;
            const gcsFile = storage.bucket(BUCKET_NAME).file(destination);
            
            await gcsFile.save(file.buffer, {
              metadata: { contentType: file.mimetype }
            });
            
            uploadedFiles.push({
              fieldname: file.fieldname,
              filename: file.filename,
              gcsPath: `gs://${BUCKET_NAME}/${destination}`,
              size: file.size
            });
            
            console.log(`✅ Uploaded: ${file.filename}`);
          } catch (uploadError) {
            console.error(`❌ Upload failed for ${file.filename}:`, uploadError);
          }
        }
        
        doc.files = uploadedFiles;
      }

      // Save to Firestore
      await firestore.collection('applications').doc(applicationId).set(doc);
      console.log(`✅ Database save completed for ${applicationId}`);
      
    } catch (backgroundError) {
      console.error('❌ Background processing failed:', backgroundError);
    }
    
    console.log('=== REQUEST COMPLETE ===');

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ Function error:', error);
    
    res.status(500).json({
      success: false,
      error: 'Processing failed',
      message: error.message,
      duration
    });
  }
});
