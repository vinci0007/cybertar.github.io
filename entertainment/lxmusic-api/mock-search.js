// 这个文件用于处理模拟的音源请求
// 由于浏览器环境限制，我们不能直接运行Node.js音源
// 因此我们创建一个模拟接口来模拟真实音源的行为

// 模拟搜索功能
async function mockSearch(keyword, source, page = 1, limit = 20) {
    // 根据不同音源返回不同格式的模拟数据
    const mockData = {
        kw: { // 酷我
            list: [
                {
                    id: `kw_${Date.now()}_1`,
                    name: `${keyword} - 酷我歌曲1`,
                    singer: '酷我歌手1',
                    albumName: '酷我专辑1',
                    interval: 240,
                    source: 'kw',
                    songmid: `kw_songmid_${Date.now()}_1`,
                    albumId: 'kw_album_1'
                },
                {
                    id: `kw_${Date.now()}_2`,
                    name: `${keyword} - 酷我歌曲2`,
                    singer: '酷我歌手2',
                    albumName: '酷我专辑2',
                    interval: 180,
                    source: 'kw',
                    songmid: `kw_songmid_${Date.now()}_2`,
                    albumId: 'kw_album_2'
                }
            ],
            total: 50,
            limit: limit,
            page: page
        },
        kg: { // 酷狗
            list: [
                {
                    id: `kg_${Date.now()}_1`,
                    name: `${keyword} - 酷狗歌曲1`,
                    singer: '酷狗歌手1',
                    albumName: '酷狗专辑1',
                    interval: 220,
                    source: 'kg',
                    songmid: `kg_songmid_${Date.now()}_1`,
                    albumId: 'kg_album_1'
                },
                {
                    id: `kg_${Date.now()}_2`,
                    name: `${keyword} - 酷狗歌曲2`,
                    singer: '酷狗歌手2',
                    albumName: '酷狗专辑2',
                    interval: 200,
                    source: 'kg',
                    songmid: `kg_songmid_${Date.now()}_2`,
                    albumId: 'kg_album_2'
                }
            ],
            total: 45,
            limit: limit,
            page: page
        },
        tx: { // QQ音乐
            list: [
                {
                    id: `tx_${Date.now()}_1`,
                    name: `${keyword} - QQ音乐歌曲1`,
                    singer: 'QQ歌手1',
                    albumName: 'QQ专辑1',
                    interval: 260,
                    source: 'tx',
                    songmid: `tx_songmid_${Date.now()}_1`,
                    albumId: 'tx_album_1'
                },
                {
                    id: `tx_${Date.now()}_2`,
                    name: `${keyword} - QQ音乐歌曲2`,
                    singer: 'QQ歌手2',
                    albumName: 'QQ专辑2',
                    interval: 190,
                    source: 'tx',
                    songmid: `tx_songmid_${Date.now()}_2`,
                    albumId: 'tx_album_2'
                }
            ],
            total: 60,
            limit: limit,
            page: page
        },
        wy: { // 网易云
            list: [
                {
                    id: `wy_${Date.now()}_1`,
                    name: `${keyword} - 网易云歌曲1`,
                    singer: '网易歌手1',
                    albumName: '网易专辑1',
                    interval: 250,
                    source: 'wy',
                    songmid: `wy_songmid_${Date.now()}_1`,
                    albumId: 'wy_album_1'
                },
                {
                    id: `wy_${Date.now()}_2`,
                    name: `${keyword} - 网易云歌曲2`,
                    singer: '网易歌手2',
                    albumName: '网易专辑2',
                    interval: 210,
                    source: 'wy',
                    songmid: `wy_songmid_${Date.now()}_2`,
                    albumId: 'wy_album_2'
                }
            ],
            total: 55,
            limit: limit,
            page: page
        },
        mg: { // 咪咕
            list: [
                {
                    id: `mg_${Date.now()}_1`,
                    name: `${keyword} - 咪咕歌曲1`,
                    singer: '咪咕歌手1',
                    albumName: '咪咕专辑1',
                    interval: 230,
                    source: 'mg',
                    songmid: `mg_songmid_${Date.now()}_1`,
                    albumId: 'mg_album_1'
                },
                {
                    id: `mg_${Date.now()}_2`,
                    name: `${keyword} - 咪咕歌曲2`,
                    singer: '咪咕歌手2',
                    albumName: '咪咕专辑2',
                    interval: 195,
                    source: 'mg',
                    songmid: `mg_songmid_${Date.now()}_2`,
                    albumId: 'mg_album_2'
                }
            ],
            total: 40,
            limit: limit,
            page: page
        }
    };

    // 根据源返回相应的模拟数据
    if (mockData[source]) {
        return mockData[source];
    } else {
        // 如果找不到对应的源，返回默认数据
        return {
            list: [
                {
                    id: `${source}_${Date.now()}_1`,
                    name: `${keyword} - 模拟歌曲1`,
                    singer: '模拟歌手1',
                    albumName: '模拟专辑1',
                    interval: 240,
                    source: source,
                    songmid: `${source}_songmid_${Date.now()}_1`
                },
                {
                    id: `${source}_${Date.now()}_2`,
                    name: `${keyword} - 模拟歌曲2`,
                    singer: '模拟歌手2',
                    albumName: '模拟专辑2',
                    interval: 180,
                    source: source,
                    songmid: `${source}_songmid_${Date.now()}_2`
                }
            ],
            total: 30,
            limit: limit,
            page: page
        };
    }
}

// 模拟获取音乐URL功能
async function mockGetMusicUrl(songInfo, source, quality = '128k') {
    // 生成模拟的音乐URL
    const mockUrl = `https://music.${source}.com/play/${songInfo.songmid || songInfo.id}?quality=${quality}`;
    
    return {
        url: mockUrl,
        quality: quality,
        expireTime: Date.now() + 3600000 // 1小时后过期
    };
}

// 模拟获取歌词功能
async function mockGetLyric(songInfo, source) {
    return {
        lyric: `[00:00.00] ${songInfo.name || '歌曲名'} - ${songInfo.singer || '歌手'}\n[00:10.00] 这是模拟的歌词\n[00:15.00] 用于测试显示效果\n[00:20.00] 实际使用中会从音源获取真实歌词\n`,
        tlyric: '' // 翻译歌词
    };
}

// 导出函数
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        mockSearch,
        mockGetMusicUrl,
        mockGetLyric
    };
}