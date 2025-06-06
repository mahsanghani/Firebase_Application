const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');

// Initialize services
const firestore = new Firestore();
const storage = new Storage();
const BUCKET_NAME = 'internship-applications-files';

// Validation rules
const REQUIRED_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'university', 'major', 'graduationDate', 'position', 'availability', 'motivation', 'terms'];

// Raw multipart parser - no external dependencies
function parseMultipartData(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  const endBoundaryBuffer = Buffer.from('--' + boundary + '--');
  
  let offset = 0;
  
  // Find first boundary
  const firstBoundaryIndex = buffer.indexOf(boundaryBuffer, offset);
  if (firstBoundaryIndex === -1) {
    throw new Error('No multipart boundary found');
  }
  
  offset = firstBoundaryIndex + boundaryBuffer.length;
  
  while (offset < buffer.length) {
    // Skip CRLF after boundary
    if (buffer[offset] === 0x0D && buffer[offset + 1] === 0x0A) {
      offset += 2;
    }
    
    // Find next boundary or end
    const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, offset);
    const endBoundaryIndex = buffer.indexOf(endBoundaryBuffer, offset);
    
    let partEnd;
    if (endBoundaryIndex !== -1 && (nextBoundaryIndex === -1 || endBoundaryIndex < nextBoundaryIndex)) {
      partEnd = endBoundaryIndex;
    } else if (nextBoundaryIndex !== -1) {
      partEnd = nextBoundaryIndex;
    } else {
      break; // No more parts
    }
    
    // Extract part data
    const partBuffer = buffer.slice(offset, partEnd);
    
    // Find headers/body separator (\r\n\r\n)
    const headerEndIndex = partBuffer.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEndIndex === -1) {
      offset = partEnd + boundaryBuffer.length;
      continue;
    }
    
    const headerBuffer = partBuffer.slice(0, headerEndIndex);
    const bodyBuffer = partBuffer.slice(headerEndIndex + 4);
    
    // Remove trailing CRLF from body
    let bodyEnd = bodyBuffer.length;
    while (bodyEnd > 0 && (bodyBuffer[bodyEnd - 1] === 0x0A || bodyBuffer[bodyEnd - 1] === 0x0D)) {
      bodyEnd--;
    }
    const cleanBodyBuffer = bodyBuffer.slice(0, bodyEnd);
    
    // Parse headers
    const headers = headerBuffer.toString().split('\r\n');
    const part = { headers: {}, body: cleanBodyBuffer };
    
    for (const header of headers) {
      const colonIndex = header.indexOf(':');
      if (colonIndex > 0) {
        const name = header.slice(0, colonIndex).toLowerCase().trim();
        const value = header.slice(colonIndex + 1).trim();
        part.headers[name] = value;
      }
    }
    
    // Parse Content-Disposition
    const disposition = part.headers['content-disposition'];
    if (disposition) {
      const nameMatch = disposition.match(/name="([^"]+)"/);
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      
      if (nameMatch) {
        part.name = nameMatch[1];
        
        if (filenameMatch && filenameMatch[1]) {
          // It's a file
          part.filename = filenameMatch[1];
          part.contentType = part.headers['content-type'] || 'application/octet-stream';
          part.isFile = true;
        } else {
          // It's a form field
          part.value = cleanBodyBuffer.toString('utf8');
          part.isFile = false;
        }
      }
    }
    
    parts.push(part);
    offset = partEnd + boundaryBuffer.length;
  }
  
  return parts;
}

// Process raw multipart request
function parseRawMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    
    if (!boundaryMatch) {
      reject(new Error('No boundary found in Content-Type header'));
      return;
    }
    
    const boundary = boundaryMatch[1].replace(/"/g, '');
    console.log('Parsing multipart with boundary:', boundary);
    
    const chunks = [];
    let totalLength = 0;
    
    req.on('data', (chunk) => {
      chunks.push(chunk);
      totalLength += chunk.length;
      
      // Prevent memory issues
      if (totalLength > 50 * 1024 * 1024) { // 50MB limit
        reject(new Error('Request too large'));
      }
    });
    
    req.on('end', () => {
      try {
        console.log(`Received ${totalLength} bytes of multipart data`);
        const buffer = Buffer.concat(chunks);
        const parts = parseMultipartData(buffer, boundary);
        
        console.log(`Parsed ${parts.length} multipart parts`);
        
        const fields = {};
        const files = [];
        
        for (const part of parts) {
          if (part.name) {
            if (part.isFile && part.filename) {
              files.push({
                fieldname: part.name,
                filename: part.filename,
                buffer: part.body,
                mimetype: part.contentType,
                size: part.body.length
              });
              console.log(`File: ${part.filename} (${part.body.length} bytes)`);
            } else if (!part.isFile) {
              fields[part.name] = part.value;
              console.log(`Field: ${part.name} = ${part.value.substring(0, 50)}${part.value.length > 50 ? '...' : ''}`);
            }
          }
        }
        
        resolve({ fields, files });
      } catch (parseError) {
        console.error('Parse error:', parseError);
        reject(parseError);
      }
    });
    
    req.on('error', (error) => {
      console.error('Request error:', error);
      reject(error);
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
      processingMethod = 'multipart-raw';
      console.log('Using raw multipart parser...');
      
      try {
        // Use raw multipart parser with timeout
        const result = await Promise.race([
          parseRawMultipart(req),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Multipart parsing timeout')), 15000)
          )
        ]);
        
        applicationData = result.fields;
        files = result.files;
        
        console.log(`Raw multipart parsing successful: ${Object.keys(applicationData).length} fields, ${files.length} files`);
        
      } catch (multipartError) {
        console.error('Raw multipart parsing failed:', multipartError.message);
        
        return res.status(400).json({
          success: false,
          error: 'Multipart parsing error',
          message: multipartError.message,
          suggestion: 'Try submitting as JSON without files, or check file sizes and formats',
          duration: Date.now() - startTime
        });
      }
      
    } else if (contentType.includes('application/json')) {
      processingMethod = 'json';
      console.log('Processing JSON data');
      applicationData = req.body || {};
      
    } else {
      processingMethod = 'other';
      console.log('Processing other data format');
      applicationData = req.body || {};
    }

    console.log(`Processing method: ${processingMethod}`);
    console.log('Fields received:', Object.keys(applicationData));
    console.log('Files received:', files.length);

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
    console.log('Starting background file processing...');
    
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
              resumable: false
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
