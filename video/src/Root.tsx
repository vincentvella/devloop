import { Composition } from "remotion";
import { DevloopHero } from "./DevloopHero";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DevloopHero"
      component={DevloopHero}
      durationInFrames={435}
      fps={30}
      width={1280}
      height={720}
    />
  );
};
