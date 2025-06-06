const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const Busboy = require('busboy');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Initialize Firestore and Storage
const firestore = new Firestore();
const storage = new Storage();

// Your bucket name for file uploads
const BUCKET_NAME = 'internship-applications-files'; // Create this bucket in GCS

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
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    const applicationData = {};
    const files = [];
    const busboy = Busboy({ headers: req.headers });

    // Process form fields and files
    await new Promise((resolve, reject) => {
      busboy.on('field', (fieldname, val) => {
        applicationData[fieldname] = val;
      });

      busboy.on('file', (fieldname, file, { filename, mimeType }) => {
        if (filename) {
          const tmpFilePath = path.join(os.tmpdir(), filename);
          const writeStream = fs.createWriteStream(tmpFilePath);
          
          file.pipe(writeStream);
          
          files.push({
            fieldname,
            filename,
            mimeType,
            tmpFilePath
          });
        }
      });

      busboy.on('finish', resolve);
      busboy.on('error', reject);
      
      req.pipe(busboy);
    });

    // Generate unique application ID
    const applicationId = `APP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Upload files to Google Cloud Storage
    const uploadedFiles = [];
    for (const fileInfo of files) {
      try {
        const destination = `applications/${applicationId}/${fileInfo.filename}`;
        await storage.bucket(BUCKET_NAME).upload(fileInfo.tmpFilePath, {
          destination,
          metadata: {
            contentType: fileInfo.mimeType,
          },
        });
        
        uploadedFiles.push({
          fieldname: fileInfo.fieldname,
          filename: fileInfo.filename,
          gcsPath: `gs://${BUCKET_NAME}/${destination}`,
          publicUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`
        });
        
        // Clean up temp file
        fs.unlinkSync(fileInfo.tmpFilePath);
      } catch (uploadError) {
        console.error('File upload error:', uploadError);
      }
    }

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
        terms: applicationData.terms === 'true',
        newsletter: applicationData.newsletter === 'true'
      },
      metadata: {
        submittedAt: new Date(applicationData.submittedAt || new Date().toISOString()),
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent') || 'unknown'
      }
    };

    // Save to Firestore
    await firestore.collection('internship-applications').doc(applicationId).set(firestoreData);

    // Send success response
    res.status(200).json({
      success: true,
      applicationId,
      message: 'Application submitted successfully',
      filesUploaded: uploadedFiles.length
    });

  } catch (error) {
    console.error('Error processing application:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to process application'
    });
  }
});
