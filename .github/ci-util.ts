import {exec, spawn} from "child_process";
import * as fs from 'fs';

const execCommand = (command: string) => {
  return new Promise<string>((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout ? stdout.trim() : stdout);
      }
    });
  });
};

const spawnCommand = (command: string, args: Array<string>) => {
  console.log('spawnCommand: ', command, args)
  return new Promise<void>((resolve, reject) => {
    const cmd = spawn(command, args);

    cmd.stdout.on('data', (data) => {
      console.log(`${data}`);
    });

    cmd.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });

    cmd.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`command "${command}" exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
};

async function getCommitHash() {
  const gitHash = (await execCommand('git rev-parse HEAD'));
  return gitHash.substring(0, 8);
}

function getDuration(start: Date) {
  const duration = new Date().getTime() - start.getTime();
  if (duration < 1000) {
    return `${duration} ms`;
  } else if (duration < 60 * 1000) {
    return `${(duration / 1000).toFixed(2)} sec`;
  } else if (duration < 3600 * 1000) {
    return `${(duration / 1000 / 60).toFixed(2)} min`;
  } else {
    return `${(duration / 1000 / 3600).toFixed(2)} hrs`;
  }
}

const Docker = {
  buildProcess: async (deployTags: { specific: string, latest: string }, dockerfilePath: string, buildDir: string) => {
    try {
      console.log('Docker build cwd: ', process.cwd());
      await spawnCommand('docker', [
        'build',
        '-t',
        deployTags.specific,
        '-t',
        deployTags.latest,
        '-f',
        dockerfilePath,
        buildDir,
        '--progress=plain'
      ]);
      console.log('Build complete.');
    } catch (err) {
      console.log('Error building', err);
      throw err;
    }
  },
  pushTag: async (deployTags: { specific: string, latest: string }) => {
    try {
      console.log('pushing specific to ECR: ', deployTags.specific);
      await execCommand(`docker push ${deployTags.specific}`);
      console.log('pushing latest to ECR: ', deployTags.latest);
      await execCommand(`docker push ${deployTags.latest}`);
      console.log('Upload complete');
    } catch (err: any) {
      if (err.message.includes('cannot be overwritten because the repository is immutable')) {
        console.log('Tag already exists, ignoring error');
        return;
      }
      console.log('Error pushing tag', deployTags, err);
      throw err;
    }
  }
}

const ECS = {
  getEcsClusterArn: async (environentName: string) => {
    const clustersJson = await execCommand('aws ecs list-clusters');
    const clusters = JSON.parse(clustersJson);
    const clusterArn = clusters.clusterArns.find((cluster: string) => cluster.split('/')[1].includes(environentName));
    if (!clusterArn) {
      throw new Error(`No cluster found for environment ${environentName}`);
    }
    return clusterArn;
  },
  getEcsServiceArn: async (clusterArn: string, serviceTag: string) => {
    const servicesJson = await execCommand(`aws ecs list-services --cluster ${clusterArn}`);
    const services = JSON.parse(servicesJson);
    const serviceArn = services.serviceArns.find((service: string) => service.split('/')[2].includes(serviceTag));
    if (!serviceArn) {
      throw new Error(`No service found for tag ${serviceTag}`);
    }
    return serviceArn;
  },
  restartEcsService: async (env: string, appName: string) => {
    const clusterArn = await ECS.getEcsClusterArn(env);
    const serviceArn = await ECS.getEcsServiceArn(clusterArn, appName);
    await spawnCommand(`aws`, [
      'ecs',
      'update-service',
      '--cluster',
      clusterArn,
      '--service',
      serviceArn,
      '--force-new-deployment'
    ])
  },

}

const ECR = {
  getEcrTag: (repositoryName: string, accountId: string, region: string, commitHash: string) => {
    return {
      specific: `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}:${commitHash}`,
      latest: `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}:latest`
    };
  },
  checkIfTagExists: async (repositoryName: string, tag: string) => {
    let result;
    try {
      result = await execCommand(`aws ecr describe-images --repository-name ${repositoryName} --image-ids imageTag=${tag}`);
      return true;
    } catch (err: any) {
      if (err.message.includes('ImageNotFoundException')) {
        return false;
      } else {
        console.log('Error checking tag: ', err);
        throw err;
      }
    }
  },
  refreshEcrToken: async (region: string, accountId: string) => {
    await execCommand(`docker login --username AWS --password \$(aws ecr get-login-password --region ${region}) ${accountId}.dkr.ecr.${region}.amazonaws.com`);
  }
}

const Cloudformation = {
  deployEcsService: async (region: string, env: string, appName: string, stackDir: string) => {
    // console.log('Deploying ECS service', region, env, packageName, processName);
    const stackName = `${env}-service-${appName}`;

    // console.log('Loading params for', packageName
    const parametersJson = JSON.parse(await fs.promises.readFile(`${stackDir}/parameters/${env}.json`, 'utf-8')).Parameters;
    const parameters = Object.keys(parametersJson).map(key => `${key}=${parametersJson[key]}`);
    parameters.push(`AppName=${appName}`);
    parameters.push(`EnvironmentName=${env}`);
    try {
      await spawnCommand(`aws`, [
        'cloudformation',
        'deploy',
        '--template-file',
        `${stackDir}/stack.yml`,
        '--stack-name',
        stackName,
        '--region',
        region,
        '--capabilities',
        'CAPABILITY_NAMED_IAM',
        '--parameter-overrides',
        ...parameters
      ])
    } catch (err) {
      console.error('Deploy failed, checking stack events');
      await spawnCommand(`aws`, [
        'cloudformation',
        'describe-stack-events',
        '--stack-name',
        stackName
      ]);
      throw err;
    }
  },
  deployLambda: async (accountId: string, region: string, env: string, appName: string, stackDir: string, s3Bucket: string) => {
    // console.log('Deploying Lambda', region, env, packageName, processName, s3Bucket);

    const stackName = `${env}-${appName}`;
    // const stackDir = `packages/${packageName}/.aws/${processName}`;

    await spawnCommand('aws', [
      'cloudformation',
      'package',
      '--template',
      `${stackDir}/stack.yml`,
      '--s3-bucket',
      s3Bucket,
      '--output-template',
      'packaged-application.yml'
    ]);

    const jsonString = fs.readFileSync(`${stackDir}/parameters/${env}.json`, 'utf-8');
    const jsonObj = JSON.parse(jsonString);

    const parameters = Object.entries(jsonObj.Parameters).map(([key, value]) => `${key}=${value}`);

    const repositoryName = `${env}/${appName}`;
    const commitHash = await getCommitHash();
    const deployTags = ECR.getEcrTag(repositoryName, accountId, region, commitHash);
    parameters.push(`ImageUri=${deployTags.specific}`);

    await spawnCommand('aws', [
      'cloudformation',
      'deploy',
      '--template-file',
      'packaged-application.yml',
      '--stack-name',
      stackName,
      '--capabilities',
      'CAPABILITY_NAMED_IAM',
      '--region',
      region,
      '--parameter-overrides',
      ...parameters
    ]);
  }
}


abstract class Command {
  protected env: string;
  protected region: string;
  protected accountId: string;

  protected constructor(params: { [key: string]: string }) {
    this.env = params.env;
    this.region = params.region;
    this.accountId = params.account;
    if (!this.env) {
      throw new Error('No env specified');
    }
    if (!this.region) {
      throw new Error('No region specified');
    }
    if (!this.accountId) {
      throw new Error('No aws_account_id specified');
    }
  }

  abstract run(): Promise<void>;
}

class BuildCommand extends Command {
  private dockerFilePath: string;
  private buildDir: string;
  private appName: string;

  constructor(params: { [key: string]: string }) {
    super(params);
    this.dockerFilePath = params.dockerfile_path;
    this.appName = params.app_name;
    this.buildDir = params.build_dir;
    if (!this.dockerFilePath) {
      throw new Error('No dockerFilePath specified');
    }
    if (!this.appName) {
      throw new Error('No appName specified');
    }
    if (!this.buildDir) {
      throw new Error('No buildDir specified');
    }
  }

  async run() {
    await this.loadEnvFile();
    await ECR.refreshEcrToken(this.region, this.accountId);
    const repositoryName = `${this.env}/${this.appName}`;
    const commitHash = await getCommitHash();
    if (await ECR.checkIfTagExists(repositoryName, commitHash)) {
      return;
    }
    console.log('Building and pushing commitHash: ', commitHash, 'to ECR repository: ', repositoryName);
    const deployTags = ECR.getEcrTag(repositoryName, this.accountId, this.region, commitHash);
    // const buildPath = path.dirname(dockerFilePath);
    const start = new Date();
    await Docker.buildProcess(deployTags, this.dockerFilePath, this.buildDir);
    console.log('Build time: ', getDuration(start));
    const tick = new Date();
    await Docker.pushTag(deployTags);
    console.log('Push time: ', getDuration(tick));
  }

  private async loadEnvFile() {
    const envFile = `.circleci/env/${this.env}.env`
    if (!fs.existsSync(envFile)) {
      return;
    }
    const envString = await fs.promises.readFile(envFile, 'utf-8');
    envString.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      console.log('Setting env: ', key, value);
      process.env[key] = value;
    });
  }
}

class DeployCommand extends Command {
  private appName: string;
  private stackDir: string;
  private bucket?: string;

  constructor(params: { [key: string]: string }) {
    super(params);
    this.appName = params.app_name;
    this.stackDir = params.stack_dir;
    this.bucket = params.bucket;
    if (!this.appName) {
      throw new Error('No appName specified');
    }
    if (!this.stackDir) {
      throw new Error('No stackDir specified');
    }
  }

  async run() {
    console.log('deploying', this.appName, 'stack to', this.env);
    if (this.appName.includes('lambda')) {
      if (!this.bucket) {
        throw new Error('No bucket specified for lambda deployment');
      }
      await Cloudformation.deployLambda(this.accountId, this.region, this.env, this.appName, this.stackDir, this.bucket);
    } else {
      await Cloudformation.deployEcsService(this.region, this.env, this.appName, this.stackDir);
      console.log('Restarting the service so updated ecr image is used even if service was not updated by Cloudformation');
      // TODO: Detect if service was updated by Cloudformation and only restart if it wasn't
      await ECS.restartEcsService(this.env, this.appName);
    }
  }
}

enum CommandType {
  Build = 'build',
  Deploy = 'deploy'
}

function parseCommand(type: CommandType, params: { [key: string]: string }): Command {
  switch (type) {
    case CommandType.Build:
      return new BuildCommand(params);
    case CommandType.Deploy:
      return new DeployCommand(params);
    default:
      throw new Error('Invalid command type');
  }
}

function parseArgs() {
  const args = process.argv.slice(3);
  const commandType = process.argv[2] as CommandType;
  if (!commandType) {
    throw new Error('No commandType specified');
  }
  const parsedArgs: { [key: string]: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for argument: --${key}`);
      }
      parsedArgs[key] = value;
      i++; // Skip the next value as it's already processed
    }
  }
  return {
    commandType,
    args: parsedArgs
  }
}


const {commandType, args} = parseArgs();
console.log('Parsed arguments:', args);

const command = parseCommand(commandType, args);

command.run()
.then(() => process.exit(0))
.catch(err => {
  console.error(err);
  process.exit(1);
});
