import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────

function makeCmd(name: string) {
  return class {
    static readonly __name = name;
    readonly __name: string;
    constructor(public input: Record<string, unknown> = {}) {
      this.__name = name;
    }
  };
}

vi.mock("@aws-sdk/client-ec2", () => {
  const send = vi.fn();
  class EC2Client {
    send = send;
    constructor(_config: unknown) {}
  }
  return {
    EC2Client,
    DescribeInstancesCommand: makeCmd("DescribeInstancesCommand"),
    StartInstancesCommand: makeCmd("StartInstancesCommand"),
    StopInstancesCommand: makeCmd("StopInstancesCommand"),
    RebootInstancesCommand: makeCmd("RebootInstancesCommand"),
    TerminateInstancesCommand: makeCmd("TerminateInstancesCommand"),
    RunInstancesCommand: makeCmd("RunInstancesCommand"),
    CreateImageCommand: makeCmd("CreateImageCommand"),
    DescribeImagesCommand: makeCmd("DescribeImagesCommand"),
    DeregisterImageCommand: makeCmd("DeregisterImageCommand"),
    DescribeVolumesCommand: makeCmd("DescribeVolumesCommand"),
    CreateSnapshotCommand: makeCmd("CreateSnapshotCommand"),
    DescribeSnapshotsCommand: makeCmd("DescribeSnapshotsCommand"),
    DescribeVpcsCommand: makeCmd("DescribeVpcsCommand"),
    DescribeSubnetsCommand: makeCmd("DescribeSubnetsCommand"),
    DescribeSecurityGroupsCommand: makeCmd("DescribeSecurityGroupsCommand"),
    ImportImageCommand: makeCmd("ImportImageCommand"),
    DescribeImportImageTasksCommand: makeCmd("DescribeImportImageTasksCommand"),
    ImportSnapshotCommand: makeCmd("ImportSnapshotCommand"),
    DescribeImportSnapshotTasksCommand: makeCmd("DescribeImportSnapshotTasksCommand"),
    RegisterImageCommand: makeCmd("RegisterImageCommand"),
    ExportImageCommand: makeCmd("ExportImageCommand"),
    DescribeExportImageTasksCommand: makeCmd("DescribeExportImageTasksCommand"),
    CreateTagsCommand: makeCmd("CreateTagsCommand"),
    __ec2Send: send,
  };
});

vi.mock("@aws-sdk/client-s3", () => {
  const send = vi.fn();
  class S3Client {
    send = send;
    constructor(_config: unknown) {}
  }
  return {
    S3Client,
    GetObjectCommand: makeCmd("GetObjectCommand"),
    HeadObjectCommand: makeCmd("HeadObjectCommand"),
    DeleteObjectCommand: makeCmd("DeleteObjectCommand"),
    __s3Send: send,
  };
});

vi.mock("@aws-sdk/client-sts", () => {
  const send = vi.fn();
  class STSClient {
    send = send;
    constructor(_config: unknown) {}
  }
  return {
    STSClient,
    GetCallerIdentityCommand: makeCmd("GetCallerIdentityCommand"),
    __stsSend: send,
  };
});

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: vi.fn(),
}));

import { AWSClient } from "../../src/providers/aws/client.js";

async function getEc2Send() {
  const mod = await import("@aws-sdk/client-ec2");
  return (mod as unknown as { __ec2Send: ReturnType<typeof vi.fn> }).__ec2Send;
}

async function getS3Send() {
  const mod = await import("@aws-sdk/client-s3");
  return (mod as unknown as { __s3Send: ReturnType<typeof vi.fn> }).__s3Send;
}

async function getStsSend() {
  const mod = await import("@aws-sdk/client-sts");
  return (mod as unknown as { __stsSend: ReturnType<typeof vi.fn> }).__stsSend;
}

async function getUploadCtor() {
  const mod = await import("@aws-sdk/lib-storage");
  return (mod as unknown as { Upload: ReturnType<typeof vi.fn> }).Upload;
}

type Cmd = { __name: string; input: Record<string, unknown> };

function routeEc2(responses: Record<string, unknown | ((input: Record<string, unknown>) => unknown)>) {
  return (cmd: Cmd) => {
    const resp = responses[cmd.__name];
    if (resp === undefined) {
      throw new Error(`Unmocked EC2 command: ${cmd.__name}`);
    }
    const value = typeof resp === "function" ? (resp as (i: Record<string, unknown>) => unknown)(cmd.input) : resp;
    return Promise.resolve(value);
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("AWSClient", () => {
  let client: AWSClient;

  beforeEach(async () => {
    const ec2Send = await getEc2Send();
    const s3Send = await getS3Send();
    const stsSend = await getStsSend();
    const Upload = await getUploadCtor();
    ec2Send.mockReset();
    s3Send.mockReset();
    stsSend.mockReset();
    Upload.mockReset();

    client = new AWSClient({
      accessKeyId: "AKIAFAKE",
      secretAccessKey: "secret",
      region: "us-east-2",
    });
  });

  describe("connection & STS", () => {
    it("connects by calling GetCallerIdentity and reports connected", async () => {
      const stsSend = await getStsSend();
      stsSend.mockResolvedValue({ Account: "123456789012", Arn: "arn:aws:iam::x:user/vclaw", UserId: "AIDAX" });

      expect(client.isConnected()).toBe(false);
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(stsSend).toHaveBeenCalledTimes(1);

      client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it("returns caller identity fields (coerces undefined to empty string)", async () => {
      const stsSend = await getStsSend();
      stsSend.mockResolvedValue({});
      const identity = await client.getCallerIdentity();
      expect(identity).toEqual({ accountId: "", arn: "", userId: "" });
    });

    it("passes sessionToken when provided", async () => {
      // Construct a new client with sessionToken — checking it doesn't throw
      const tokenClient = new AWSClient({
        accessKeyId: "AKIA",
        secretAccessKey: "s",
        region: "us-west-2",
        sessionToken: "tok",
      });
      expect(tokenClient.isConnected()).toBe(false);
    });
  });

  describe("listInstances", () => {
    it("maps DescribeInstances response to EC2InstanceSummary array", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeInstancesCommand: {
          Reservations: [{
            Instances: [{
              InstanceId: "i-1",
              InstanceType: "t3.micro",
              State: { Name: "running" },
              VpcId: "vpc-1",
              SubnetId: "sub-1",
              Placement: { AvailabilityZone: "us-east-2a" },
              PublicIpAddress: "1.2.3.4",
              PrivateIpAddress: "10.0.0.1",
              LaunchTime: new Date("2026-01-01T00:00:00Z"),
              PlatformDetails: "Linux/UNIX",
              Tags: [{ Key: "Name", Value: "web-1" }, { Key: "env", Value: "prod" }],
            }],
          }],
        },
      }));

      const result = await client.listInstances();
      expect(result).toEqual([{
        instanceId: "i-1",
        name: "web-1",
        state: "running",
        instanceType: "t3.micro",
        vpcId: "vpc-1",
        subnetId: "sub-1",
        availabilityZone: "us-east-2a",
        publicIp: "1.2.3.4",
        privateIp: "10.0.0.1",
        launchTime: "2026-01-01T00:00:00.000Z",
        platform: "Linux/UNIX",
      }]);
    });

    it("passes filters converted to Name/Values shape", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeInstancesCommand: (input) => {
          expect(input.Filters).toEqual([
            { Name: "tag:Name", Values: ["web"] },
            { Name: "instance-state-name", Values: ["running"] },
          ]);
          return { Reservations: [] };
        },
      }));

      await client.listInstances({
        "tag:Name": ["web"],
        "instance-state-name": ["running"],
      });
    });

    it("returns empty array when no reservations", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({ DescribeInstancesCommand: {} }));
      expect(await client.listInstances()).toEqual([]);
    });

    it("defaults missing fields to empty strings / 'pending'", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeInstancesCommand: {
          Reservations: [{ Instances: [{ InstanceId: "i-2" }] }],
        },
      }));
      const [inst] = await client.listInstances();
      expect(inst.name).toBe("");
      expect(inst.state).toBe("pending");
      expect(inst.availabilityZone).toBe("");
      expect(inst.launchTime).toBe("");
    });
  });

  describe("getInstance", () => {
    it("returns detailed instance info", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeInstancesCommand: (input) => {
          expect(input.InstanceIds).toEqual(["i-1"]);
          return {
            Reservations: [{
              Instances: [{
                InstanceId: "i-1",
                InstanceType: "t3.micro",
                State: { Name: "running" },
                Placement: { AvailabilityZone: "us-east-2a" },
                Architecture: "x86_64",
                ImageId: "ami-1",
                KeyName: "mykey",
                IamInstanceProfile: { Arn: "arn:aws:iam::x:instance-profile/role" },
                BlockDeviceMappings: [{
                  DeviceName: "/dev/sda1",
                  Ebs: {
                    VolumeId: "vol-1",
                    Status: "attached",
                    AttachTime: new Date("2026-01-01T00:00:00Z"),
                    DeleteOnTermination: true,
                  },
                }],
                SecurityGroups: [{ GroupId: "sg-1", GroupName: "default" }],
                NetworkInterfaces: [{
                  NetworkInterfaceId: "eni-1",
                  SubnetId: "sub-1",
                  VpcId: "vpc-1",
                  PrivateIpAddress: "10.0.0.1",
                  Association: { PublicIp: "1.2.3.4" },
                  Status: "in-use",
                  MacAddress: "aa:bb:cc:dd:ee:ff",
                  Groups: [{ GroupId: "sg-1", GroupName: "default" }],
                }],
              }],
            }],
          };
        },
      }));

      const detail = await client.getInstance("i-1");
      expect(detail.instanceId).toBe("i-1");
      expect(detail.architecture).toBe("x86_64");
      expect(detail.imageId).toBe("ami-1");
      expect(detail.keyName).toBe("mykey");
      expect(detail.iamInstanceProfile).toBe("arn:aws:iam::x:instance-profile/role");
      expect(detail.blockDeviceMappings[0].ebs?.volumeId).toBe("vol-1");
      expect(detail.securityGroups).toEqual([{ groupId: "sg-1", groupName: "default" }]);
      expect(detail.networkInterfaces[0].publicIp).toBe("1.2.3.4");
      expect(detail.networkInterfaces[0].securityGroups).toEqual([{ groupId: "sg-1", groupName: "default" }]);
    });

    it("throws when instance not found", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeInstancesCommand: { Reservations: [] },
      }));

      await expect(client.getInstance("i-404")).rejects.toThrow("Instance not found: i-404");
    });
  });

  describe("instance lifecycle", () => {
    it("startInstance sends StartInstancesCommand with correct InstanceIds", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        StartInstancesCommand: (input) => {
          expect(input.InstanceIds).toEqual(["i-1"]);
          return {};
        },
      }));
      await client.startInstance("i-1");
    });

    it("stopInstance, rebootInstance, terminateInstance call expected commands", async () => {
      const ec2Send = await getEc2Send();
      const calls: string[] = [];
      ec2Send.mockImplementation((cmd: Cmd) => {
        calls.push(cmd.__name);
        expect(cmd.input.InstanceIds).toEqual(["i-1"]);
        return Promise.resolve({});
      });

      await client.stopInstance("i-1");
      await client.rebootInstance("i-1");
      await client.terminateInstance("i-1");

      expect(calls).toEqual([
        "StopInstancesCommand",
        "RebootInstancesCommand",
        "TerminateInstancesCommand",
      ]);
    });

    it("launchInstance returns summary and tags instance when name provided", async () => {
      const ec2Send = await getEc2Send();
      const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
      ec2Send.mockImplementation((cmd: Cmd) => {
        calls.push({ name: cmd.__name, input: cmd.input });
        if (cmd.__name === "RunInstancesCommand") {
          return Promise.resolve({
            Instances: [{
              InstanceId: "i-new",
              InstanceType: "t3.micro",
              State: { Name: "pending" },
              Placement: { AvailabilityZone: "us-east-2a" },
            }],
          });
        }
        return Promise.resolve({});
      });

      const result = await client.launchInstance({
        amiId: "ami-1",
        instanceType: "t3.micro",
        subnetId: "sub-1",
        securityGroupIds: ["sg-1", "sg-2"],
        keyName: "mykey",
        name: "web-2",
      });

      expect(result.instanceId).toBe("i-new");
      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe("RunInstancesCommand");
      expect(calls[0].input).toMatchObject({
        ImageId: "ami-1",
        InstanceType: "t3.micro",
        SubnetId: "sub-1",
        SecurityGroupIds: ["sg-1", "sg-2"],
        KeyName: "mykey",
        MinCount: 1,
        MaxCount: 1,
      });
      expect(calls[1].name).toBe("CreateTagsCommand");
      expect(calls[1].input).toEqual({
        Resources: ["i-new"],
        Tags: [{ Key: "Name", Value: "web-2" }],
      });
    });

    it("launchInstance does not tag when name is not provided", async () => {
      const ec2Send = await getEc2Send();
      const calls: string[] = [];
      ec2Send.mockImplementation((cmd: Cmd) => {
        calls.push(cmd.__name);
        if (cmd.__name === "RunInstancesCommand") {
          return Promise.resolve({ Instances: [{ InstanceId: "i-new" }] });
        }
        return Promise.resolve({});
      });

      await client.launchInstance({ amiId: "ami-1", instanceType: "t3.micro" });
      expect(calls).toEqual(["RunInstancesCommand"]);
    });

    it("launchInstance throws when no instance returned", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        RunInstancesCommand: { Instances: [] },
      }));

      await expect(
        client.launchInstance({ amiId: "ami-1", instanceType: "t3.micro" })
      ).rejects.toThrow("Failed to launch instance");
    });
  });

  describe("AMI", () => {
    it("createImage returns imageId", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        CreateImageCommand: (input) => {
          expect(input).toMatchObject({
            InstanceId: "i-1",
            Name: "backup",
            Description: "pre-upgrade",
            NoReboot: true,
          });
          return { ImageId: "ami-new" };
        },
      }));

      const id = await client.createImage("i-1", "backup", "pre-upgrade");
      expect(id).toBe("ami-new");
    });

    it("createImage throws when no ImageId returned", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({ CreateImageCommand: {} }));
      await expect(client.createImage("i-1", "backup")).rejects.toThrow("Failed to create image");
    });

    it("describeImages uses Owners=self when no imageIds", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeImagesCommand: (input) => {
          expect(input).toEqual({ Owners: ["self"] });
          return {
            Images: [{
              ImageId: "ami-1",
              Name: "my-ami",
              State: "available",
              Architecture: "x86_64",
              PlatformDetails: "Linux",
              CreationDate: "2026-01-01T00:00:00Z",
              OwnerId: "123",
              BlockDeviceMappings: [{
                DeviceName: "/dev/sda1",
                Ebs: { VolumeSize: 8, VolumeType: "gp3", DeleteOnTermination: true },
              }],
            }],
          };
        },
      }));
      const amis = await client.describeImages();
      expect(amis).toHaveLength(1);
      expect(amis[0].imageId).toBe("ami-1");
      expect(amis[0].blockDeviceMappings[0].ebs?.volumeId).toBe("8");
    });

    it("describeImages passes specific imageIds when provided", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeImagesCommand: (input) => {
          expect(input).toEqual({ ImageIds: ["ami-1"] });
          return { Images: [] };
        },
      }));
      await client.describeImages(["ami-1"]);
    });

    it("deregisterImage sends DeregisterImageCommand with imageId", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DeregisterImageCommand: (input) => {
          expect(input.ImageId).toBe("ami-1");
          return {};
        },
      }));
      await client.deregisterImage("ami-1");
    });
  });

  describe("EBS volumes & snapshots", () => {
    it("listVolumes maps response and attachments", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeVolumesCommand: {
          Volumes: [{
            VolumeId: "vol-1",
            Size: 100,
            State: "in-use",
            VolumeType: "gp3",
            AvailabilityZone: "us-east-2a",
            Encrypted: true,
            Attachments: [{ InstanceId: "i-1", Device: "/dev/sda1", State: "attached" }],
          }],
        },
      }));

      const volumes = await client.listVolumes();
      expect(volumes).toEqual([{
        volumeId: "vol-1",
        size: 100,
        state: "in-use",
        volumeType: "gp3",
        availabilityZone: "us-east-2a",
        encrypted: true,
        attachments: [{ instanceId: "i-1", device: "/dev/sda1", state: "attached" }],
      }]);
    });

    it("createSnapshot returns snapshot info", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        CreateSnapshotCommand: {
          SnapshotId: "snap-1",
          VolumeId: "vol-1",
          State: "pending",
          StartTime: new Date("2026-01-01T00:00:00Z"),
          VolumeSize: 100,
          Description: "pre-migration",
          Encrypted: false,
        },
      }));

      const snap = await client.createSnapshot("vol-1", "pre-migration");
      expect(snap).toEqual({
        snapshotId: "snap-1",
        volumeId: "vol-1",
        state: "pending",
        startTime: "2026-01-01T00:00:00.000Z",
        volumeSize: 100,
        description: "pre-migration",
        encrypted: false,
      });
    });

    it("describeSnapshots defaults to OwnerIds=self", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeSnapshotsCommand: (input) => {
          expect(input).toEqual({ OwnerIds: ["self"] });
          return { Snapshots: [] };
        },
      }));
      await client.describeSnapshots();
    });

    it("describeSnapshots passes specific snapshotIds when provided", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeSnapshotsCommand: (input) => {
          expect(input).toEqual({ SnapshotIds: ["snap-1"] });
          return { Snapshots: [] };
        },
      }));
      await client.describeSnapshots(["snap-1"]);
    });
  });

  describe("VPC / networking", () => {
    it("listVPCs maps response with Name tag extracted", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeVpcsCommand: {
          Vpcs: [{
            VpcId: "vpc-1",
            CidrBlock: "10.0.0.0/16",
            State: "available",
            IsDefault: true,
            Tags: [{ Key: "Name", Value: "main-vpc" }],
          }],
        },
      }));
      const vpcs = await client.listVPCs();
      expect(vpcs[0]).toEqual({
        vpcId: "vpc-1",
        cidrBlock: "10.0.0.0/16",
        state: "available",
        isDefault: true,
        name: "main-vpc",
      });
    });

    it("listSubnets filters by vpcId when provided", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeSubnetsCommand: (input) => {
          expect(input.Filters).toEqual([{ Name: "vpc-id", Values: ["vpc-1"] }]);
          return {
            Subnets: [{
              SubnetId: "sub-1",
              VpcId: "vpc-1",
              CidrBlock: "10.0.1.0/24",
              AvailabilityZone: "us-east-2a",
              AvailableIpAddressCount: 250,
            }],
          };
        },
      }));
      const subs = await client.listSubnets("vpc-1");
      expect(subs[0].subnetId).toBe("sub-1");
      expect(subs[0].availableIps).toBe(250);
    });

    it("listSubnets omits Filters when no vpcId", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeSubnetsCommand: (input) => {
          expect(input.Filters).toBeUndefined();
          return { Subnets: [] };
        },
      }));
      await client.listSubnets();
    });

    it("listSecurityGroups maps inbound & outbound rules", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeSecurityGroupsCommand: {
          SecurityGroups: [{
            GroupId: "sg-1",
            GroupName: "web",
            VpcId: "vpc-1",
            Description: "web tier",
            IpPermissions: [{
              IpProtocol: "tcp",
              FromPort: 443,
              ToPort: 443,
              IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "https" }],
              UserIdGroupPairs: [],
            }],
            IpPermissionsEgress: [{
              IpProtocol: "-1",
              IpRanges: [{ CidrIp: "0.0.0.0/0" }],
              UserIdGroupPairs: [],
            }],
          }],
        },
      }));

      const sgs = await client.listSecurityGroups();
      expect(sgs[0].inboundRules[0]).toMatchObject({
        protocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ["0.0.0.0/0"],
        description: "https",
      });
      expect(sgs[0].outboundRules[0].protocol).toBe("-1");
    });
  });

  describe("import / export", () => {
    it("importImage returns task id", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        ImportImageCommand: (input) => {
          expect(input.DiskContainers).toEqual([{
            Format: "VMDK",
            UserBucket: { S3Bucket: "bucket", S3Key: "key.vmdk" },
          }]);
          expect(input.Description).toBe("from vmware");
          return { ImportTaskId: "import-1" };
        },
      }));

      const id = await client.importImage({
        s3Bucket: "bucket",
        s3Key: "key.vmdk",
        format: "vmdk",
        description: "from vmware",
      });
      expect(id).toBe("import-1");
    });

    it("importImage throws when no ImportTaskId", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({ ImportImageCommand: {} }));

      await expect(client.importImage({
        s3Bucket: "b",
        s3Key: "k",
        format: "vmdk",
      })).rejects.toThrow("Failed to import image");
    });

    it("describeImportTasks maps progress, snapshotId, and imageId", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeImportImageTasksCommand: {
          ImportImageTasks: [{
            ImportTaskId: "import-1",
            Status: "active",
            Progress: "42",
            SnapshotDetails: [{ SnapshotId: "snap-1" }],
            ImageId: "ami-123",
          }],
        },
      }));

      const tasks = await client.describeImportTasks();
      expect(tasks[0]).toMatchObject({
        importTaskId: "import-1",
        status: "active",
        progress: "42",
        snapshotId: "snap-1",
        imageId: "ami-123",
      });
    });

    it("importSnapshot returns task id", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        ImportSnapshotCommand: (input) => {
          expect(input.DiskContainer).toEqual({
            Format: "RAW",
            UserBucket: { S3Bucket: "bucket", S3Key: "disk.raw" },
          });
          expect(input.Description).toBe("from proxmox");
          return { ImportTaskId: "import-snap-1" };
        },
      }));

      const id = await client.importSnapshot({
        s3Bucket: "bucket",
        s3Key: "disk.raw",
        format: "raw",
        description: "from proxmox",
      });
      expect(id).toBe("import-snap-1");
    });

    it("describeImportSnapshotTasks maps snapshot task detail", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeImportSnapshotTasksCommand: {
          ImportSnapshotTasks: [{
            ImportTaskId: "import-snap-1",
            Description: "from proxmox",
            SnapshotTaskDetail: {
              SnapshotId: "snap-9",
              Status: "active",
              StatusMessage: "uploading",
              Progress: "71",
            },
          }],
        },
      }));

      const tasks = await client.describeImportSnapshotTasks(["import-snap-1"]);
      expect(tasks[0]).toEqual({
        importTaskId: "import-snap-1",
        status: "active",
        statusMessage: "uploading",
        progress: "71",
        snapshotId: "snap-9",
        description: "from proxmox",
      });
    });

    it("registerImageFromSnapshot returns image id", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        RegisterImageCommand: (input) => {
          expect(input).toMatchObject({
            Name: "vm-1-123",
            Description: "vClaw import: vm-1",
            Architecture: "x86_64",
            RootDeviceName: "/dev/sda1",
            VirtualizationType: "hvm",
            EnaSupport: true,
            BootMode: "uefi-preferred",
            BlockDeviceMappings: [{
              DeviceName: "/dev/sda1",
              Ebs: { SnapshotId: "snap-9", DeleteOnTermination: true },
            }],
          });
          return { ImageId: "ami-9" };
        },
      }));

      const imageId = await client.registerImageFromSnapshot({
        snapshotId: "snap-9",
        name: "vm-1-123",
        description: "vClaw import: vm-1",
      });
      expect(imageId).toBe("ami-9");
    });

    it("exportImage throws when no ExportImageTaskId", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({ ExportImageCommand: {} }));
      await expect(
        client.exportImage("ami-1", "bucket", "prefix/")
      ).rejects.toThrow("Failed to export image");
    });

    it("exportImage sends command with VMDK format and returns task id", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        ExportImageCommand: (input) => {
          expect(input).toMatchObject({
            ImageId: "ami-1",
            DiskImageFormat: "VMDK",
            S3ExportLocation: { S3Bucket: "bucket", S3Prefix: "prefix/" },
          });
          return { ExportImageTaskId: "export-1" };
        },
      }));
      const id = await client.exportImage("ami-1", "bucket", "prefix/");
      expect(id).toBe("export-1");
    });

    it("describeExportTasks maps response", async () => {
      const ec2Send = await getEc2Send();
      ec2Send.mockImplementation(routeEc2({
        DescribeExportImageTasksCommand: {
          ExportImageTasks: [{
            ExportImageTaskId: "export-1",
            Status: "completed",
            ImageId: "ami-1",
            S3ExportLocation: { S3Bucket: "bucket", S3Prefix: "prefix/" },
          }],
        },
      }));
      const tasks = await client.describeExportTasks();
      expect(tasks[0]).toMatchObject({
        exportTaskId: "export-1",
        state: "completed",
        instanceId: "ami-1",
        s3Bucket: "bucket",
        s3Key: "prefix/",
      });
    });
  });

  describe("S3", () => {
    it("uploadStreamToS3 uses tuned multipart settings", async () => {
      const Upload = await getUploadCtor();
      const done = vi.fn().mockResolvedValue(undefined);
      const on = vi.fn();
      Upload.mockImplementation(function UploadMock() {
        return { done, on };
      });

      const body = new PassThrough();
      body.end("disk-bytes");
      await client.uploadStreamToS3(body, "bucket", "disk.raw");

      expect(Upload).toHaveBeenCalledTimes(1);
      expect(Upload).toHaveBeenCalledWith(expect.objectContaining({
        queueSize: 8,
        partSize: 64 * 1024 * 1024,
        params: expect.objectContaining({
          Bucket: "bucket",
          Key: "disk.raw",
          Body: body,
        }),
      }));
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("headObject returns exists=true with size and lastModified", async () => {
      const s3Send = await getS3Send();
      s3Send.mockResolvedValue({
        ContentLength: 1024,
        LastModified: new Date("2026-01-01T00:00:00Z"),
      });

      const result = await client.headObject("bucket", "key");
      expect(result).toEqual({
        exists: true,
        size: 1024,
        lastModified: "2026-01-01T00:00:00.000Z",
      });
    });

    it("headObject returns exists=false on NotFound", async () => {
      const s3Send = await getS3Send();
      const err = new Error("Not found");
      (err as Error & { name: string }).name = "NotFound";
      s3Send.mockRejectedValue(err);

      const result = await client.headObject("bucket", "missing");
      expect(result).toEqual({ exists: false, size: 0 });
    });

    it("headObject returns exists=false on NoSuchKey", async () => {
      const s3Send = await getS3Send();
      const err = new Error("No such key");
      (err as Error & { name: string }).name = "NoSuchKey";
      s3Send.mockRejectedValue(err);

      const result = await client.headObject("bucket", "missing");
      expect(result.exists).toBe(false);
    });

    it("headObject re-throws other errors", async () => {
      const s3Send = await getS3Send();
      const err = new Error("AccessDenied");
      (err as Error & { name: string }).name = "AccessDenied";
      s3Send.mockRejectedValue(err);

      await expect(client.headObject("bucket", "key")).rejects.toThrow("AccessDenied");
    });

    it("deleteObject sends DeleteObjectCommand", async () => {
      const s3Send = await getS3Send();
      s3Send.mockImplementation((cmd: Cmd) => {
        expect(cmd.__name).toBe("DeleteObjectCommand");
        expect(cmd.input).toEqual({ Bucket: "bucket", Key: "key" });
        return Promise.resolve({});
      });
      await client.deleteObject("bucket", "key");
    });
  });
});
