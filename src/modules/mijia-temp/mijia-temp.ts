import { Service, State } from 'iw-base/lib/registry';
import * as logging from 'iw-base/lib/logging';
import { IwDeepstreamClient } from 'iw-base/modules/deepstream-client';
import { Component, Inject, Scoped } from 'iw-ioc';
import { Record } from '@deepstream/client/dist/src/record/record';
import { ChildProcess, spawn } from 'child_process';
import * as readline from 'readline';

const log = logging.getLogger('MijiaTemp');

const RETRY_TIMEOUT = 5000; /* retry update after 5 seconds */
const MAX_RETRY = 10;

export interface MijiaTempConfig {
  macAddress: string;
  recordName: string;
  interval?: number;
  gatttool?: string;
}

@Component('mijia-temp')
@Scoped()
@Inject([IwDeepstreamClient])
export class MijiaTemp extends Service {

  private record: Record;
  private macAddress: string;
  private interval: number;
  private gatttool: string;

  private timer: NodeJS.Timer;
  private retryCounter: number = 0;

  private gattProcess: ChildProcess;

  constructor(private ds: IwDeepstreamClient) {
    super('mijia-temp');
  }

  async start(config: MijiaTempConfig) {
    this.macAddress = config.macAddress;
    this.interval = (config.interval ?? 300) * 1000; /* 5m default */
    this.gatttool = config.gatttool ?? '/usr/bin/gatttool';
    this.record = this.ds.getRecord(config.recordName);
    this.timer = setInterval(() => this.update(), this.interval);
    this.setState(State.OK);
    this.update();
  }

  async stop() {
    clearInterval(this.timer);
    this.closeChildProcess();
    if (this.record) {
      this.record.discard();
    }
    this.setState(State.INACTIVE);
  }

  private update() {
    if (this.retryCounter === 0) {
      this.setState(State.BUSY, 'updating values ...');
    } else if (this.retryCounter >= MAX_RETRY) {
      this.setState(State.PROBLEM, 'unable to connect to device');
      this.retryCounter = 0;
      return;
    } else {
      this.setState(State.BUSY, `updating values (retry ${this.retryCounter}) ...`);
    }
    const argv = ['--char-write-req', '-b', this.macAddress, '-a', '0x0038', '-n', '0100', '--listen'];
    log.debug('Running: %s %j', this.gatttool, argv);
    this.gattProcess = spawn(this.gatttool, argv, {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    const input = readline.createInterface(this.gattProcess.stdout);

    this.gattProcess.on('error', (err) => {
      input.close();
      this.gattProcess = undefined;
      log.error(err, 'gatttool process failed');
      this.setState(State.ERROR, 'unable to launch gatttool process');
    });
    this.gattProcess.on('exit', (code) => {
      log.error('gatttool finished with code %d', code);
      input.close();
      this.gattProcess = undefined;
      if (code === 0 || code === 130) {
        this.retryCounter = 0;
        this.setState(State.OK);
      } else {
        this.retryCounter++;
        setTimeout(() => this.update(), RETRY_TIMEOUT);
      }
    });

    let lineCounter = 0;
    input.on('line', (line) => {
      log.debug('got input: %s', line);
      if (lineCounter === 0) {
        lineCounter++;
        return;
      }
      const values = line.substring(line.indexOf('value:') + 6).trim().split(' ');
      const temp = +`0x${values[1]}${values[0]}` / 100;
      const humid = +`0x${values[2]}`;
      log.debug({ humid, temp }, 'got values');

      this.record.set({
        temperature: temp,
        humidity: humid,
        time: new Date().toISOString()
      });

      this.closeChildProcess();
    });
  }

  private closeChildProcess() {
    return new Promise<void>((resolve) => {
      if (this.gattProcess) {
        this.gattProcess.once('exit', () => {
          this.gattProcess = undefined;
          resolve();
        });
        this.gattProcess.kill('SIGINT');
      } else {
        resolve();
      }
    });
  }
}
