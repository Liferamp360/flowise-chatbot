import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Configuration parameters (from environment variables)
const FLOWISE_HOST = process.env.FLOWISE_HOST || 'http://localhost:3000';
const FLOWISE_HEALTH_API = `${process.env.FLOWISE_HOST}/api/v1/ping`;

const FLOWS_DIRECTORY = process.env.FLOWS_DIRECTORY || './flows';

interface FlowResponse {
  id: string;
  name: string;
}

async function waitForFlowiseReady(): Promise<void> {
  console.log('Waiting for Flowise to be ready...');
  
  while (true) {
    try {
      await axios.head(FLOWISE_HEALTH_API);
      console.log('Flowise is up!');
      return;
    } catch (error) {
      process.stdout.write('.');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function getCurrentFlows(): Promise<string[]> {
  try {
    const response = await axios.get<FlowResponse[]>(`${FLOWISE_HOST}/api/v1/chatflows`);
    return response.data.map(flow => flow.id);
    } catch (error) {
    console.error('Failed to get current flows:', error.response?.data || error.message);
    throw new Error('Failed to get current flows');
  }
}

async function importFlow(flowPath: string): Promise<string> {
  try {
    const flowName = path.basename(flowPath, '.json');
    console.log(`Importing flow: ${flowName}`);
    
    // Read flow configuration
    const flowData = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
    
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
          'Content-Type': 'application/json'
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
    // Wait for Flowise to be ready
    console.log('Starting Flowise configuration...');
    await waitForFlowiseReady();
    console.log('Flowise is ready');
    
    // Check current flows
    await getCurrentFlows();
    console.log('Authentication successful');
    
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
        const flowId = await importFlow(flowFile);
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