class SourceManager {
    constructor() {
        this.sources = [];
        this.enabledSources = new Set();
        this.scanInProgress = false;
        this.searchHistory = [];
        this.parsedSources = {}; // 存储解析后的音源对象
    }

    // 扫描音源文件夹
    async scanSources() {
        if (this.scanInProgress) {
            console.log('音源扫描已在进行中');
            return this.sources;
        }

        this.scanInProgress = true;
        this.sources = [];

        try {
            // 尝试获取音源文件列表
            const jsFiles = await this.getJsFilesList();
            
            // 解析每个音源文件的元数据
            for (const file of jsFiles) {
                try {
                    const sourceInfo = await this.parseSourceMetadata(file.path, file.name);
                    if (sourceInfo) {
                        this.sources.push(sourceInfo);
                    }
                } catch (error) {
                    console.warn(`解析音源文件失败 ${file.name}:`, error);
                    // 即使解析失败，也添加一个基本条目
                    const id = file.name.replace(/\.js$/, '').replace(/[^\w\s]/g, '_');
                    this.sources.push({
                        id: id,
                        name: this.formatSourceName(file.name),
                        description: '无法解析描述信息',
                        version: '未知版本',
                        path: file.path,
                        fileName: file.name
                    });
                }
            }

            // 启用所有音源作为默认设置
            this.sources.forEach(source => {
                this.enabledSources.add(source.id);
            });

            console.log(`扫描到 ${this.sources.length} 个音源`);
            return this.sources;
        } catch (error) {
            console.error('扫描音源失败:', error);
            // 返回默认音源列表作为后备
            this.sources = [
                { id: 'kw', name: '酷我音乐', path: '/entertainment/lxmusic-api/聚合API接口.js', enabled: true },
                { id: 'kg', name: '酷狗音乐', path: '/entertainment/lxmusic-api/肥猫不肥.js', enabled: true },
                { id: 'tx', name: 'QQ音乐', path: '/entertainment/lxmusic-api/野花音源.js', enabled: true },
                { id: 'wy', name: '网易云音乐', path: '/entertainment/lxmusic-api/lx-music-source-free.js', enabled: true },
                { id: 'mg', name: '咪咕音乐', path: '/entertainment/lxmusic-api/lx-music-source.js', enabled: true }
            ];
            
            this.sources.forEach(source => {
                this.enabledSources.add(source.id);
            });
            
            return this.sources;
        } finally {
            this.scanInProgress = false;
        }
    }

    // 获取JS文件列表
    async getJsFilesList() {
        try {
            // 尝试获取目录列表
            const response = await fetch('/entertainment/lxmusic-api/');
            if (response.ok) {
                const text = await response.text();
                
                // 检查是否是目录列表页面
                if (text.includes('<a') && text.includes('href')) {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(text, 'text/html');
                    
                    // 查找所有.js文件链接
                    const links = doc.querySelectorAll('a');
                    const jsFiles = [];

                    links.forEach(link => {
                        const href = link.getAttribute('href');
                        if (href && href.endsWith('.js')) {
                            // 确保href是相对路径
                            let path = href;
                            if (!href.startsWith('/')) {
                                path = `/entertainment/lxmusic-api/${href}`;
                            }
                            jsFiles.push({
                                name: href,
                                path: path
                            });
                        }
                    });

                    if (jsFiles.length > 0) {
                        return jsFiles;
                    }
                }
            }
        } catch (error) {
            console.warn('无法获取目录列表，使用预定义列表:', error);
        }

        // 如果无法获取目录列表，使用预定义的文件列表
        return [
            { name: 'Huibq.js', path: '/entertainment/lxmusic-api/Huibq.js' },
            { name: '[独家音源] v4.0.js', path: '/entertainment/lxmusic-api/[独家音源]%20v4.0.js' },
            { name: 'flower-v1.js', path: '/entertainment/lxmusic-api/flower-v1.js' },
            { name: 'grass-v1.js', path: '/entertainment/lxmusic-api/grass-v1.js' },
            { name: 'ikun-source.js', path: '/entertainment/lxmusic-api/ikun-source.js' },
            { name: 'lx-music-source-free.js', path: '/entertainment/lxmusic-api/lx-music-source-free.js' },
            { name: 'lx-music-source.js', path: '/entertainment/lxmusic-api/lx-music-source.js' },
            { name: 'nya.js', path: '/entertainment/lxmusic-api/nya.js' },
            { name: 'sixyin-music-source-v1.2.1-encrypt.js', path: '/entertainment/lxmusic-api/sixyin-music-source-v1.2.1-encrypt.js' },
            { name: '梓橙公益音源2代.js', path: '/entertainment/lxmusic-api/梓橙公益音源2代.js' },
            { name: '聚合API接口.js', path: '/entertainment/lxmusic-api/聚合API接口.js' },
            { name: '肥猫不肥.js', path: '/entertainment/lxmusic-api/肥猫不肥.js' },
            { name: '野花音源.js', path: '/entertainment/lxmusic-api/野花音源.js' },
            { name: '长青SVIP音源v1.0.0（支持无损）.js', path: '/entertainment/lxmusic-api/长青SVIP音源v1.0.0（支持无损）.js' }
        ];
    }

    // 解析音源文件的元数据
    async parseSourceMetadata(filePath, fileName) {
        try {
            const response = await fetch(filePath);
            if (!response.ok) {
                throw new Error(`无法获取文件: ${response.status}`);
            }

            const content = await response.text();
            
            // 从注释中提取元数据 - 改进正则表达式以处理不同格式
            const nameMatch = content.match(/[@#]\s*name\s+([^\n]+)/i);
            const descriptionMatch = content.match(/[@#]\s*description\s+([^\n]+)/i);
            const versionMatch = content.match(/[@#]\s*version\s+([^\n]+)/i);
            
            const name = nameMatch ? nameMatch[1].trim() : this.formatSourceName(fileName);
            const description = descriptionMatch ? descriptionMatch[1].trim() : '无描述信息';
            const version = versionMatch ? versionMatch[1].trim() : '未知版本';
            
            // 使用文件名作为ID（移除.js后缀）
            const id = fileName.replace(/\.js$/, '').replace(/[^\w\s]/g, '_');
            
            return {
                id: id,
                name: name,
                description: description,
                version: version,
                path: filePath,
                fileName: fileName,
                content: content  // 保存内容用于后续解析
            };
        } catch (error) {
            console.warn(`解析音源元数据失败 ${filePath}:`, error);
            // 如果无法解析，仍然返回基本信息
            const id = fileName.replace(/\.js$/, '').replace(/[^\w\s]/g, '_');
            return {
                id: id,
                name: this.formatSourceName(fileName),
                description: '无法解析描述信息',
                version: '未知版本',
                path: filePath,
                fileName: fileName
            };
        }
    }

    // 格式化音源名称
    formatSourceName(fileName) {
        // 移除.js扩展名
        let name = fileName.replace(/\.js$/, '');
        
        // 处理中文名称
        if (/[\u4e00-\u9fa5]/.test(name)) {
            // 如果包含中文，直接使用
            return name;
        }
        
        // 将驼峰命名转换为可读格式
        name = name.replace(/([A-Z])/g, ' $1').trim();
        
        // 替换下划线和连字符为空格
        name = name.replace(/[_-]/g, ' ');
        
        // 首字母大写
        name = name.charAt(0).toUpperCase() + name.slice(1);
        
        return name;
    }

    // 获取所有音源
    getSources() {
        return this.sources;
    }

    // 获取已启用的音源
    getEnabledSources() {
        return this.sources.filter(source => this.enabledSources.has(source.id));
    }

    // 启用音源
    enableSource(sourceId) {
        this.enabledSources.add(sourceId);
    }

    // 禁用音源
    disableSource(sourceId) {
        this.enabledSources.delete(sourceId);
    }

    // 检查音源是否启用
    isSourceEnabled(sourceId) {
        return this.enabledSources.has(sourceId);
    }

    // 获取音源详情
    getSourceById(sourceId) {
        return this.sources.find(source => source.id === sourceId);
    }
    
    // 解析并加载音源
    async loadSource(sourceId) {
        const source = this.getSourceById(sourceId);
        if (!source || !source.content) {
            console.error(`音源 ${sourceId} 不存在或内容为空`);
            return null;
        }
        
        // 检查是否已经解析过
        if (this.parsedSources[sourceId]) {
            return this.parsedSources[sourceId];
        }
        
        try {
            // 创建一个模拟的Node.js环境和LX Music环境
            const mockEnv = this.createMockEnvironment();
            
            // 将音源代码包装在函数中执行，以模拟Node.js模块系统
            const sourceModule = {
                exports: {},
                loaded: false
            };
            
            // 创建一个函数，模拟Node.js模块执行环境
            const moduleFunction = new Function(
                'module', 
                'exports', 
                'require', 
                'globalThis', 
                'Buffer',
                source.content
            );
            
            // 执行模块
            moduleFunction(
                sourceModule, 
                sourceModule.exports, 
                this.createMockRequire(), 
                globalThis,
                this.createMockBuffer()
            );
            
            // 获取导出的接口
            const sourceInterface = sourceModule.exports;
            
            // 如果没有导出接口，尝试直接执行内容
            if (!sourceInterface || Object.keys(sourceInterface).length === 0) {
                // 这里需要更复杂的解析逻辑来处理LX Music音源
                return this.createFallbackInterface(source);
            }
            
            // 将接口适配到我们的系统
            const adaptedInterface = {
                id: source.id,
                name: source.name,
                
                // 搜索音乐功能
                async searchMusic(keyword, page = 1, limit = 20) {
                    // 使用新的模拟API
                    try {
                        // 尝试映射源ID到标准源代码
                        const sourceCode = source.id.substring(0, 2).toLowerCase();
                        const validSourceCodes = ['kw', 'kg', 'tx', 'wy', 'mg'];
                        const mappedSourceCode = validSourceCodes.includes(sourceCode) ? sourceCode : 'kw';
                        
                        // 使用MusicSourceAPI
                        return await window.MusicSourceAPI.search(keyword, mappedSourceCode, page, limit);
                    } catch (error) {
                        console.error('搜索失败:', error);
                        // 返回模拟数据
                        return {
                            list: [
                                {
                                    id: `${source.id}_1`,
                                    name: `${keyword} - 模拟歌曲1`,
                                    singer: '模拟歌手1',
                                    albumName: '模拟专辑1',
                                    interval: 180,
                                    source: source.id,
                                    url: `https://music.example.com/${keyword}/1.mp3`,
                                    quality: { flac: false, wav: false, '320k': true, '128k': true }
                                },
                                {
                                    id: `${source.id}_2`,
                                    name: `${keyword} - 模拟歌曲2`,
                                    singer: '模拟歌手2',
                                    albumName: '模拟专辑2',
                                    interval: 240,
                                    source: source.id,
                                    url: `https://music.example.com/${keyword}/2.mp3`,
                                    quality: { flac: false, wav: false, '320k': true, '128k': true }
                                }
                            ],
                            total: 2,
                            limit: limit,
                            page: page
                        };
                    }
                },
                
                // 获取音乐URL功能
                async getMusicUrl(songInfo, quality = '128k') {
                    try {
                        // 尝试映射源ID到标准源代码
                        const sourceCode = source.id.substring(0, 2).toLowerCase();
                        const validSourceCodes = ['kw', 'kg', 'tx', 'wy', 'mg'];
                        const mappedSourceCode = validSourceCodes.includes(sourceCode) ? sourceCode : 'kw';
                        
                        // 使用MusicSourceAPI
                        return await window.MusicSourceAPI.getMusicUrl(songInfo, mappedSourceCode, quality);
                    } catch (error) {
                        console.error('获取音乐URL失败:', error);
                        // 返回模拟数据
                        return {
                            url: songInfo.url || `https://music.example.com/${songInfo.id || 'default'}.mp3`,
                            quality: quality,
                            expireTime: Date.now() + 3600000 // 1小时后过期
                        };
                    }
                },
                
                // 获取歌词功能
                async getLyric(songInfo) {
                    try {
                        // 尝试映射源ID到标准源代码
                        const sourceCode = source.id.substring(0, 2).toLowerCase();
                        const validSourceCodes = ['kw', 'kg', 'tx', 'wy', 'mg'];
                        const mappedSourceCode = validSourceCodes.includes(sourceCode) ? sourceCode : 'kw';
                        
                        // 使用MusicSourceAPI
                        return await window.MusicSourceAPI.getLyric(songInfo, mappedSourceCode);
                    } catch (error) {
                        console.error('获取歌词失败:', error);
                        // 返回模拟数据
                        return {
                            lyric: `[00:00.00] 暂无歌词\n`,
                            tlyric: '' // 翻译歌词
                        };
                    }
                }
            };
            
            // 缓存解析后的音源
            this.parsedSources[sourceId] = adaptedInterface;
            
            return adaptedInterface;
        } catch (error) {
            console.error(`加载音源 ${sourceId} 失败:`, error);
            // 如果解析失败，返回一个基础接口
            return this.createFallbackInterface(source);
        }
    }
    
    // 创建模拟环境
    createMockEnvironment() {
        return {
            // 模拟全局对象
            Buffer: this.createMockBuffer(),
            process: {
                env: {},
                version: 'v14.0.0'
            },
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval
        };
    }
    
    // 创建模拟Buffer
    createMockBuffer() {
        return {
            from: (str, encoding = 'utf8') => {
                if (typeof str === 'string') {
                    const encoder = new TextEncoder();
                    return encoder.encode(str);
                } else if (Array.isArray(str)) {
                    return new Uint8Array(str);
                } else {
                    return new Uint8Array(str);
                }
            },
            isBuffer: (obj) => {
                return obj instanceof Uint8Array;
            }
        };
    }
    
    // 创建模拟require
    createMockRequire() {
        return (moduleName) => {
            // 模拟Node.js内置模块
            switch (moduleName) {
                case 'crypto':
                    return {
                        createHash: (algorithm) => {
                            return {
                                update: (data) => {
                                    return {
                                        digest: (encoding) => {
                                            // 简单模拟，实际应该实现hash算法
                                            return data;
                                        }
                                    };
                                }
                            };
                        },
                        randomBytes: (size) => {
                            const arr = new Uint8Array(size);
                            for (let i = 0; i < size; i++) {
                                arr[i] = Math.floor(Math.random() * 256);
                            }
                            return arr;
                        }
                    };
                case 'path':
                    return {
                        join: (...paths) => paths.join('/'),
                        resolve: (path) => path
                    };
                default:
                    throw new Error(`不支持的模块: ${moduleName}`);
            }
        };
    }
    
    // 创建回退接口
    createFallbackInterface(source) {
        return {
            id: source.id,
            name: source.name,
            
            async searchMusic(keyword, page = 1, limit = 20) {
                // 返回模拟数据
                return {
                    list: [
                        {
                            id: `${source.id}_1`,
                            name: `${keyword} - 模拟歌曲1`,
                            singer: '模拟歌手1',
                            albumName: '模拟专辑1',
                            interval: 180,
                            source: source.id,
                            url: `https://music.example.com/${keyword}/1.mp3`,
                            quality: { flac: false, wav: false, '320k': true, '128k': true }
                        },
                        {
                            id: `${source.id}_2`,
                            name: `${keyword} - 模拟歌曲2`,
                            singer: '模拟歌手2',
                            albumName: '模拟专辑2',
                            interval: 240,
                            source: source.id,
                            url: `https://music.example.com/${keyword}/2.mp3`,
                            quality: { flac: false, wav: false, '320k': true, '128k': true }
                        }
                    ],
                    total: 2,
                    limit: limit,
                    page: page
                };
            },
            
            async getMusicUrl(songInfo, quality = '128k') {
                return {
                    url: songInfo.url || `https://music.example.com/${songInfo.id || 'default'}.mp3`,
                    quality: quality,
                    expireTime: Date.now() + 3600000 // 1小时后过期
                };
            },
            
            async getLyric(songInfo) {
                return {
                    lyric: `[00:00.00] 暂无歌词\n`,
                    tlyric: ''
                };
            }
        };
    }
    
    // 搜索音乐 - 通过解析后的音源
    async searchMusic(query, sourceId = null) {
        try {
            // 如果没有指定音源，使用当前启用的音源
            const sourcesToSearch = sourceId 
                ? [this.getSourceById(sourceId)] 
                : this.getEnabledSources();
            
            if (sourcesToSearch.length === 0) {
                console.warn('没有启用的音源');
                return [];
            }
            
            const searchResults = [];
            
            for (const source of sourcesToSearch) {
                console.log(`使用音源 ${source.name} 搜索: ${query}`);
                
                try {
                    // 加载并执行音源
                    const sourceInterface = await this.loadSource(source.id);
                    if (!sourceInterface) {
                        console.error(`无法加载音源 ${source.name}`);
                        continue;
                    }
                    
                    // 调用音源的搜索功能
                    const result = await sourceInterface.searchMusic(query, 1, 10);
                    
                    if (result && result.list && Array.isArray(result.list)) {
                        // 处理搜索结果
                        const results = result.list.map(item => {
                            return {
                                id: `${source.id}_${item.id || item.songmid}`,
                                title: item.name || item.title || '未知标题',
                                artist: item.singer || item.artist || '未知艺术家',
                                album: item.albumName || item.album || '未知专辑',
                                duration: item.interval || item.duration || 0,
                                source: source.name,
                                sourceId: source.id,
                                songmid: item.songmid || item.id,
                                albumId: item.albumId || null,
                                payPlay: item.payPlay || false,
                                // 存储音源信息以供后续获取URL
                                rawInfo: item,
                                quality: item.quality || { flac: false, wav: false, '320k': true, '128k': true }
                            };
                        });
                        
                        searchResults.push(...results);
                    }
                } catch (error) {
                    console.error(`搜索音源 ${source.name} 时出错:`, error);
                }
            }
            
            // 添加到搜索历史
            this.searchHistory.push({
                query,
                timestamp: Date.now(),
                resultsCount: searchResults.length
            });
            
            // 限制搜索历史长度
            if (this.searchHistory.length > 50) {
                this.searchHistory = this.searchHistory.slice(-50);
            }
            
            return searchResults;
        } catch (error) {
            console.error('搜索音乐时发生错误:', error);
            return [];
        }
    }
    
    // 获取音乐播放URL
    async getMusicUrl(songInfo) {
        try {
            // 获取对应的音源
            const source = this.getSourceById(songInfo.sourceId);
            if (!source) {
                console.error(`找不到音源: ${songInfo.sourceId}`);
                return null;
            }
            
            // 加载并执行音源
            const sourceInterface = await this.loadSource(source.id);
            if (!sourceInterface) {
                console.error(`无法加载音源 ${source.name}`);
                return null;
            }
            
            // 获取音乐URL
            const result = await sourceInterface.getMusicUrl(songInfo.rawInfo || songInfo, '128k');
            
            if (result && result.url) {
                return result.url;
            }
            
            return null;
        } catch (error) {
            console.error('获取音乐URL时发生错误:', error);
            return null;
        }
    }
}