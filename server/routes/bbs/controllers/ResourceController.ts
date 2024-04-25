import { Sequelize } from 'sequelize';
import { Request, Response } from 'express';
import {
  BodyParam,
  Controller,
  Delete,
  ForbiddenError,
  Get,
  NotFoundError,
  Param,
  Post,
  QueryParam,
  Req,
  Res,
  UploadedFile,
} from 'routing-controllers';
import CurrentUser from '../decorators/CurrentUser';
import { User } from '../../../models/User';
import CurrentDB from '../decorators/CurrentDB';
import CurrentDomain from '../decorators/CurrentDomain';

import fse = require('fs-extra');
import path = require('path');
import Throttle = require('throttle');
import multer = require('multer');
import mime = require('mime-types');
import { getDB, getDBNameFromHost } from '../../../models/db';
import { getSettingValue } from '../../../models/Settings';
import UIError from '../../../utils/ui-error';
import ReqLog, { ReqLogger } from '../decorators/ReqLog';
import { getValidUserTokens } from '../../../models/UserToken';
import { formatSize } from '../../../utils/format-utils';
import { DBResourceDir } from '../const';
import getHostFromUrl from '../../../utils/get-host-from-url';
import { getBindHosts } from '../../../utils/bind-host-util';
import * as childProcess from 'child_process';

let resourceIdNext = 1;

function getResourceFilePath(resourcePath: string) {
  return path.join(DBResourceDir, path.join('/', resourcePath));
}

/**
 * 资源接口控制器
 * 注意注解为普通 Controller，非 JsonController，返回格式和其他 Controller 会有差异
 */
@Controller('/resources')
export default class ResourceController {
  // 新增判断文件是否为视频的函数，根据实际需求修改判断条件
  private isVideoFile(file: Express.Multer.File): boolean {
    const videoExtensions = ['.mp4', '.avi', '.mov']; // 根据实际需求添加视频文件的扩展名
    const extname = path.extname(file.originalname).toLowerCase();
    return videoExtensions.includes(extname);
  }

  // 新增转换为m3u8格式的函数，根据实际需求修改实现
  private async convertToM3u8(filePath: string): Promise<void> {
    const outputDirectory = path.dirname(filePath);
    const fileNameWithoutSuffix = path.basename(filePath, path.extname(filePath));
    const outputFileName = fileNameWithoutSuffix + '.m3u8';
    const outputPath = path.join(outputDirectory, outputFileName);
    return new Promise((resolve, reject) => {
      // ffmpeg 命令行参数，根据需要调整
      const ffmpegArgs = [
        '-i',
        filePath, // 输入文件路径
        '-c:v',
        'libx264', // 视频编码器
        '-c:a',
        'aac', // 音频编码器
        '-strict',
        'experimental',
        '-b:a',
        '192k', // 音频比特率
        '-b:v',
        '1024k', // 视频比特率
        // '-s', '640x360',          // 视频分辨率
        '-hls_time',
        '20', // 分片时间间隔
        '-hls_list_size',
        '0', // 不保存所有分片信息到m3u8文件中
        '-hls_segment_filename',
        `${outputDirectory}/${fileNameWithoutSuffix}_segment_%03d.ts`, // 分片文件名格式
        outputPath, // 输出m3u8文件路径
      ];

      const ffmpegProcess = childProcess.spawn('ffmpeg', ffmpegArgs);

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg process exited with code ${code}`));
        }
      });

      ffmpegProcess.on('error', (err) => {
        reject(err);
      });
    });
  }

  @Post('/')
  async post(
    @ReqLog('resources_write.json.log') resourcesWriteLogger: ReqLogger,
    @CurrentUser({ required: true }) currentUser: User,
    @CurrentDB() db: Sequelize,
    @CurrentDomain() domain: string,
    @Res() res: Response,
    @BodyParam('fileName') fileName: string,
    @UploadedFile('file', {
      options: {
        storage: multer.diskStorage({}),
      },
    })
    file: Express.Multer.File,
  ) {
    try {
      const resourceSizeLimit = parseInt(await getSettingValue(db, 'attachment_size_limit')) || 10 * 1024 * 1024;
      if (file.size > resourceSizeLimit) {
        throw new UIError(`上传文件大小（${formatSize(file.size)}）超限（${formatSize(resourceSizeLimit)}）`);
      }
      if (fileName.startsWith('attachment/') && !(await currentUser.hasPermission('attachment.create.0'))) {
        throw new UIError(`无上传附件/视频权限`);
      }
      if (!fileName.startsWith('attachment/') && !(await currentUser.hasPermission('attachment.create.1'))) {
        throw new UIError(`无上传图片权限`);
      }
      const fileKey = `${Date.now()}_${resourceIdNext++}${path.extname(fileName)}`;
      let filePath = `${domain}/${fileName.startsWith('attachment/') ? 'attachment/' : ''}${fileKey}`;
      const resFilePath = getResourceFilePath(filePath);
      await fse.mkdirs(path.dirname(resFilePath));
      await fse.move(file.path, resFilePath, { overwrite: true });
      resourcesWriteLogger.log({ filePath, fileSize: file.size });

      // 新增判断上传文件为视频的逻辑，并调用转换函数
      if (this.isVideoFile(file)) {
        this.convertToM3u8(resFilePath);
      }

      return {
        filePath,
      };
    } catch (e) {
      res.status(500);
      return e;
    }
  }

  @Delete('/:filePath')
  async delete(
    @ReqLog('resources_delete.json.log') resourcesDeleteLogger: ReqLogger,
    @CurrentUser({ required: true }) currentUser: User,
    @CurrentDB() db: Sequelize,
    @CurrentDomain() domain: string,
    @Res() res: Response,
    @Param('filePath') filePath: string,
  ) {
    try {
      if (!filePath.startsWith(`${domain}/`)) {
        throw new UIError("can't delete other domain's resource");
      }
      const resFilePath = getResourceFilePath(filePath);
      await fse.remove(resFilePath);
      res.type('application/json');
      resourcesDeleteLogger.log({ filePath });
      return true;
    } catch (e) {
      res.status(500);
      return e;
    }
  }

  @Get('/:domain/attachment/:fileName')
  async getAttachment(
    @Res() res: Response,
    @Req() req: Request,
    @ReqLog('resources_read.json.log') resourcesReadLogger: ReqLogger,
    @Param('domain') domain: string,
    @Param('fileName') fileName: string,
    @QueryParam('download') download: string,
    @QueryParam('token') token: string,
    @QueryParam('uid') uid: string,
  ) {
    return this.get(res, req, resourcesReadLogger, domain, `attachment/${fileName}`, download, token, uid);
  }

  @Get('/:domain/:fileName')
  async get(
    @Res() res: Response,
    @Req() req: Request,
    @ReqLog('resources_read.json.log') resourcesReadLogger: ReqLogger,
    @Param('domain') domain: string,
    @Param('fileName') fileName: string,
    @QueryParam('download') download: string,
    @QueryParam('token') token: string,
    @QueryParam('uid') uid: string,
  ) {
    try {
      const db = await getDB(domain);
      if (fileName.startsWith('attachment/')) {
        // 附件校验登录态
        // if (token.length < 8 || !uid) {
        //   throw new ForbiddenError('出错：附件仅登录后可访问');
        // }
        // const userTokens = await getValidUserTokens(db, parseInt(uid));
        // if (!userTokens.some((t) => t.token.startsWith(token))) {
        //   throw new ForbiddenError('出错：附件仅登录后可访问');
        // }
      } else {
        // 图片校验 referer
        if (req.headers.referer && (await getSettingValue(db, '__internal_check_referer')) === '1') {
          const refererHost = getHostFromUrl(req.headers.referer);
          if (refererHost !== 'localhost' && !(await getBindHosts(domain)).includes(refererHost)) {
            console.log(`request resource(${domain}/${fileName}) with invalid referer: "${req.headers.referer}"`);
            throw new ForbiddenError(`invalid referer: "${req.headers.referer}"`);
          }
        }
      }

      let resFilePath = getResourceFilePath(`${domain}/${encodeURIComponent(fileName)}`);
      if (!fse.existsSync(resFilePath)) {
        resFilePath = getResourceFilePath(`${domain}/${fileName}`);
      }
      if (!fse.existsSync(resFilePath)) {
        res.status(404);
        return new NotFoundError();
      }
      const fileStat = fse.statSync(resFilePath);
      if (fileStat.isDirectory()) {
        res.status(500);
        return new ForbiddenError(`"${resFilePath}" is a directory`);
      }

      try {
        res.type(mime.lookup(fileName));
      } catch (e) {
        // ignore
      }

      if (download === '1') {
        const sourceFileName = path.basename(fileName);
        res.attachment(sourceFileName);
      }

      const rateLimit = parseInt(await getSettingValue(db, 'attachment_load_rate')) || 64 * 1024;
      resourcesReadLogger.log({ fileName, fileSize: fileStat.size, rateLimit, download });
      res.setHeader('Cache-Control', 'max-age=31536000'); // 设置浏览器缓存
      res.setHeader('Content-Length', String(fileStat.size));
      return fse.createReadStream(resFilePath).pipe(new Throttle(rateLimit)); // 限速
    } catch (e) {
      res.status(500);
      return e;
    }
  }
}
