import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Configuration parameters (from environment variables)
const FLOWISE_HOST = process.env.FLOWISE_HOST || 'http://localhost:3000';
const FLOWISE_HEALTH_API = `${FLOWISE_HOST}/api/v1/ping`;

const FLOWS_DIRECTORY = process.env.FLOWS_DIRECTORY || './flows';

interface FlowResponse {
  id: string;
  name: string;
}

async function launchFlowise() {
  console.log('Starting Flowise...');
  const child = spawn('sh', ['-c', 'cd packages/server/bin && ./run start'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  
}

async function waitForFlowiseReady(): Promise<void> {
  console.log('Waiting for Flowise to be ready...');

  let numTries = 0;
  const maxTries = 20;
  let mostRecentError: any = null;
  while (numTries < maxTries) {
    try {
      console.log('Checking Flowise health...', FLOWISE_HEALTH_API);
      await axios.head(FLOWISE_HEALTH_API);
      console.log('Flowise is up!');
      return;
    } catch (error) {
      process.stdout.write('.');
      mostRecentError = error;
      // console.error(error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  console.error('Flowise did not start in time:', mostRecentError);
}

async function loadApiKey() {
  try {
    const keyToUse = JSON.parse(fs.readFileSync('packages/server/api.json', 'utf-8'))[0];
    console.log('API Key loaded:', keyToUse.keyName);
    return keyToUse.apiKey;
  } catch (error) {
    console.error('Failed to load API key:', error.message);
    throw new Error('Failed to load API key');
  }
}

// async function createApiKey() {
//   try {
//     const response = await axios.post(`${FLOWISE_HOST}/api/v1/apikeys`, { name: 'default' });
//     console.log('API Key created:', response.data);
//     return response.data[0].apiKey;
//   } catch (error) {
//     console.error('Failed to create API key:', error.response?.data || error.message);
//     throw new Error('Failed to create API key');
//   }
// }

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
    const flowData = fs.readFileSync(flowPath, 'utf-8');
    
    // Import the flow
    const response = await axios.post<FlowResponse>(
      `${FLOWISE_HOST}/api/v1/chatflows`,
      {
        name: flowName,
        flowData,
        deployed: true,
        isPublic: true,
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
  } catch (error: any) {
    console.error(`Flow import failed for ${flowPath}:`, error.response?.data || error.message);
    throw new Error(`Failed to import flow: ${flowPath}`);
  }
}

async function main() {
  try {

    // Start Flowise
    console.log('Starting Flowise...');
    await launchFlowise();
    console.log('Flowise started');

    // Wait for Flowise to be ready
    console.log('Waiting for Flowise to be ready...');
    await waitForFlowiseReady();
    console.log('Flowise is ready');

    const apikey = await loadApiKey();
    console.log('API Key loaded successfully');
    
    // Check current flows
    const currentFlows = await getCurrentFlows(apikey);
    console.log('Current flows:', currentFlows);
    
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
        const flowId = await importFlow(apikey, flowFile);
        console.log(`Flow ${flowFile} imported with ID ${flowId}`);
      } catch (error: any) {
        console.error(`Error processing flow ${flowFile}:`, error.message);
        // Continue with other flows
      }
    }
    
    console.log('Flowise configuration complete!');
  } catch (error: any) {
    console.error('Startup script failed:', error.message);
    // process.exit(1);
  }
}

// Run the main function
main()
.then(() => {

  // Keep the script running
  setInterval(() => {}, 1000);
})
.catch(error => {
  console.error('Flowise start script failed:', error.message);
  process.exit(1);
});