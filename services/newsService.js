/**
 * @file newsService.js
 * @description Football news provider facade.
 */

const isDemoNewsEnabled = () => process.env.ENABLE_DEMO_NEWS !== 'false';

const demoNews = () => {
  const now = Date.now();

  return [
    {
      id: 'news_ucl_clash',
      title: 'UEFA Champions League: Electrifying Nights Await European Giants',
      excerpt: 'Tactical masterclasses and record-breaking performances as clubs push towards the Munich 2025 final.',
      summary: 'Tactical masterclasses and record-breaking performances as clubs push towards the Munich 2025 final.',
      content: 'The UEFA Champions League knockout stages delivered spectacle and heart-stopping drama across European capitals. Heavyweights showed tactical discipline while youthful prodigies seized the spotlight on football’s most prestigious stage. Managers emphasized squad depth and high-tempo pressing as crucial factors for continental supremacy.',
      category: 'Champions League',
      imageUrl: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=800&q=80',
      publishedAt: new Date(now - 1000 * 60 * 35).toISOString(),
      author: 'KickSphere Football Desk',
      source: 'KickSphere News',
      tags: ['UCL', 'ChampionsLeague', 'Football'],
      isDemo: true,
      sourceType: 'verified'
    },
    {
      id: 'news_pl_title_race',
      title: 'Premier League: Intense Title Race Down to the Wire',
      excerpt: 'Every point matters as the title contenders battle in one of the closest Premier League seasons in history.',
      summary: 'Every point matters as the title contenders battle in one of the closest Premier League seasons in history.',
      content: 'With only fine margins separating the top clubs, the Premier League title race continues to captivate millions globally. Relentless attacking flair combined with resolute defensive blocks has defined recent fixtures. Analysts predict that consistency in upcoming derbies will decide who lifts the coveted trophy.',
      category: 'Premier League',
      imageUrl: 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?w=800&q=80',
      publishedAt: new Date(now - 1000 * 60 * 120).toISOString(),
      author: 'David Hughes',
      source: 'KickSphere Sports',
      tags: ['PremierLeague', 'TitleRace', 'England'],
      isDemo: true,
      sourceType: 'verified'
    },
    {
      id: 'news_el_clasico',
      title: 'La Liga Highlights: El Clásico Rivalry Reaches New Tactical Heights',
      excerpt: 'Spain’s marquee matchup showcases precision midfield control and world-class attacking power.',
      summary: 'Spain’s marquee matchup showcases precision midfield control and world-class attacking power.',
      content: 'The historic clash between Spain’s most decorated clubs delivered breathtaking intensity. Tactical adaptations, fluid transitions, and individual brilliance left fans on the edge of their seats throughout the ninety minutes.',
      category: 'La Liga',
      imageUrl: 'https://images.unsplash.com/photo-1574629810360-7efbb1925619?w=800&q=80',
      publishedAt: new Date(now - 1000 * 60 * 240).toISOString(),
      author: 'Carlos Morales',
      source: 'Marca Global',
      tags: ['LaLiga', 'ElClasico', 'Spain'],
      isDemo: true,
      sourceType: 'verified'
    },
    {
      id: 'news_transfer_window',
      title: 'Global Transfer Radar: Top Prospects Linked to Premier Clubs',
      excerpt: 'Scouts across Europe monitor breakthrough talents ahead of the upcoming summer window.',
      summary: 'Scouts across Europe monitor breakthrough talents ahead of the upcoming summer window.',
      content: 'European sporting directors are actively preparing major bids for emerging defensive midfielders and clinical wingers. Market valuations continue to climb as release clauses and contract negotiations take center stage.',
      category: 'Transfers',
      imageUrl: 'https://images.unsplash.com/photo-1489944440615-453fc2b6a9a9?w=800&q=80',
      publishedAt: new Date(now - 1000 * 60 * 480).toISOString(),
      author: 'Fabrizio Scout',
      source: 'Transfer Hub',
      tags: ['Transfers', 'Rumours', 'Mercato'],
      isDemo: true,
      sourceType: 'verified'
    },
    {
      id: 'news_tactical_breakdown',
      title: 'Modern Tactical Evolution: Inverted Fullbacks and Box Midfields',
      excerpt: 'How leading tacticians are reshaping positional play in modern world football.',
      summary: 'How leading tacticians are reshaping positional play in modern world football.',
      content: 'A deep tactical analysis examining how hybrid fullbacks and dual number-tens are dominating central zones. The study breaks down pressing efficiency, counter-pressing triggers, and spatial dominance in top European leagues.',
      category: 'Tactics',
      imageUrl: 'https://images.unsplash.com/photo-1518091043644-c1d4457512c6?w=800&q=80',
      publishedAt: new Date(now - 1000 * 60 * 720).toISOString(),
      author: 'Tactics Room',
      source: 'Football Analytics',
      tags: ['Tactics', 'Analysis', 'Coaching'],
      isDemo: true,
      sourceType: 'verified'
    }
  ];
};

exports.getLatestNews = async (limit = 10) => {
  if (!isDemoNewsEnabled()) {
    return [];
  }

  return demoNews().slice(0, limit);
};

exports.getNewsStatus = () => ({
  provider: isDemoNewsEnabled() ? 'demo' : 'none',
  demo: isDemoNewsEnabled()
});
