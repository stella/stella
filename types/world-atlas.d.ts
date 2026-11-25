declare module "world-atlas/countries-50m.json" {
  const topology: {
    transform: { scale: number[]; translate: number[] };
    arcs: number[][][];
    objects: {
      countries: {
        geometries: {
          id?: string;
          arcs: unknown;
          properties: { name: string };
        }[];
      };
    };
  };
  export default topology;
}
