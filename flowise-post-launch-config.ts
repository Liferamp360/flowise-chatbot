import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Configuration parameters (from environment variables)
const FLOWISE_HOST = process.env.FLOWISE_HOST || 'http://localhost:3000';
const FLOWISE_USERNAME = process.env.FLOWISE_USERNAME || 'admin';
const FLOWISE_PASSWORD = process.env.FLOWISE_PASSWORD || 'password';
const FLOWS_DIRECTORY = process.env.FLOWS_DIRECTORY || './flows';
const API_KEY_NAME = process.env.API_KEY_NAME || 'production-api-key';
const API_KEY_DESCRIPTION = process.env.API_KEY_DESCRIPTION || 'Automatically generated API key';
const API_KEY_EXPIRY = parseInt(process.env.API_KEY_EXPIRY || '0', 10); // 0 = no expiry

interface AuthResponse {
  accessToken: string;
}

interface ApiKeyResponse {
  id: string;
  apiKey: string;
  keyName: string;
}

interface FlowResponse {
  id: string;
  name: string;
}

async function waitForFlowiseReady(): Promise<void> {
  console.log('Waiting for Flowise to be ready...');
  
  while (true) {
    try {
      await axios.head(FLOWISE_HOST);
      console.log('Flowise is up!');
      return;
    } catch (error) {
      process.stdout.write('.');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function getAuthToken(): Promise<string> {
  try {
    const response = await axios.post<AuthResponse>(`${FLOWISE_HOST}/api/v1/user/login`, {
      username: FLOWISE_USERNAME,
      password: FLOWISE_PASSWORD
    });
    
    return response.data.accessToken;
  } catch (error) {
    console.error('Authentication failed:', error.response?.data || error.message);
    throw new Error('Failed to authenticate with Flowise');
  }
}

async function createApiKey(token: string): Promise<string> {
  try {
    console.log('Creating API key...');
    
    const response = await axios.post<ApiKeyResponse>(
      `${FLOWISE_HOST}/api/v1/apikey`,
      {
        keyName: API_KEY_NAME,
        description: API_KEY_DESCRIPTION,
        expirationDate: API_KEY_EXPIRY
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    console.log(`API key created with name: ${response.data.keyName}`);
    return response.data.apiKey;
  } catch (error) {
    console.error('API key creation failed:', error.response?.data || error.message);
    throw new Error('Failed to create API key');
  }
}

async function getCurrentFlows(token: string): Promise<string[]> {
  try {
    const response = await axios.get<FlowResponse[]>(`${FLOWISE_HOST}/api/v1/chatflows`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    return response.data.map(flow => flow.id);
    } catch (error) {
    console.error('Failed to get current flows:', error.response?.data || error.message);
    throw new Error('Failed to get current flows');
  }
}

async function importFlow(token: string, flowPath: string): Promise<string> {
  try {
    const flowName = path.basename(flowPath, '.json');
    console.log(`Importing flow: ${flowName}`);
    
    // Read flow configuration
    const flowData = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
    
    // Import the flow
    const response = await axios.post<FlowResponse>(
      `${FLOWISE_HOST}/api/v1/chatflows`,
      {
        flowData,
        deployed: true,
        isPublic: true,
        name: flowName,
        type: 'CHATFLOW'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    const flowId = response.data.id;
    console.log(`Flow ${flowName} imported successfully with ID: ${flowId}`);
    
    return flowId;
  } catch (error) {
    console.error(`Flow import failed for ${flowPath}:`, error.response?.data || error.message);
    throw new Error(`Failed to import flow: ${flowPath}`);
  }
}

async function main() {
  try {
    // Wait for Flowise to be ready
    console.log('Starting Flowise configuration...');
    await waitForFlowiseReady();
    console.log('Flowise is ready');
    
    // Authenticate and get token
    const token = await getAuthToken();
    console.log('Authentication successful');
    
    // Create API key
    const apiKey = await createApiKey(token);
    console.log('API key created');
    
    // Store API key in a file for other processes to use if needed
    fs.writeFileSync('./api_key.txt', apiKey);
    console.log('API key stored in api_key.txt');
    
    // Import and deploy all flow configurations
    console.log('Importing flows...');
    
    // Ensure the flows directory exists
    if (!fs.existsSync(FLOWS_DIRECTORY)) {
      console.warn(`Flows directory ${FLOWS_DIRECTORY} does not exist!`);
      return;
    }
    
    // Get all .json files in the flows directory
    const flowFiles = fs.readdirSync(FLOWS_DIRECTORY)
      .filter(file => file.endsWith('.json'))
      .map(file => path.join(FLOWS_DIRECTORY, file));

    console.log(`Deploying ${flowFiles.length} flows: ${flowFiles}`);
    
    // Import and deploy each flow
    for (const flowFile of flowFiles) {
      try {
        const flowId = await importFlow(token, flowFile);
        console.log(`Flow ${flowFile} imported with ID ${flowId}`);
      } catch (error: any) {
        console.error(`Error processing flow ${flowFile}:`, error.message);
        // Continue with other flows
      }
    }
    
    console.log('Flowise configuration complete!');
  } catch (error: any) {
    console.error('Startup script failed:', error.message);
    process.exit(1);
  }
}

// Run the main function
main();