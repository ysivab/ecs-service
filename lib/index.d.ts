import { Construct } from 'constructs';
export interface EcsServiceStackProps {
    appName: string;
    services: any;
}
export declare class EcsService extends Construct {
    constructor(scope: Construct, id: string, props: EcsServiceStackProps);
}
