import { FileTextOutlined, PictureOutlined, VideoCameraOutlined, BuildOutlined, SoundOutlined } from '@ant-design/icons';
import { toWebviewUrl, resolveLocalPath } from '@/services/video/asset-store';
import type { StudioAsset } from '@/types/video-studio';

export default function StudioMedia({ asset, controls = true }: { asset?: StudioAsset; controls?: boolean }) {
  const url = asset?.url ? toWebviewUrl(resolveLocalPath(asset.url)) : undefined;
  return <div className="video-studio-media">
    {asset?.kind === 'image' && url ? <img src={url} alt={asset.name} loading="lazy" />
      : asset?.kind === 'video' && url ? <video src={url} controls={controls} preload="metadata" playsInline />
        : asset?.kind === 'audio' && url ? <audio src={url} controls={controls} preload="metadata" />
          : asset?.kind === 'text' && asset.text ? <pre className="video-studio-text-preview">{asset.text}</pre>
            : asset?.kind === 'model' ? <BuildOutlined /> : asset?.kind === 'text' ? <FileTextOutlined /> : asset?.kind === 'video' ? <VideoCameraOutlined /> : asset?.kind === 'audio' ? <SoundOutlined /> : <PictureOutlined />}
  </div>;
}
